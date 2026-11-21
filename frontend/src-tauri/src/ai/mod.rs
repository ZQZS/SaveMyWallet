pub(crate) mod assistant_inputs;
pub(crate) mod credentials;
mod deepseek;
pub(crate) mod images;
pub(crate) mod pet_chat;
mod requests;

use crate::ledger::{month_index, MAX_CENTS};
use deepseek::DeepSeek;
pub(crate) use requests::AiRequests;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

const REMINDER: &str = include_str!("../../../resources/ai/prompts/reminder.md");
const VISION: &str = include_str!("../../../resources/ai/prompts/vision.md");
const SCENARIO: &str = include_str!("../../../resources/ai/prompts/scenario.md");

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReminderFacts {
    month: String,
    balance_cents: i64,
    due_cents: i64,
    warning_floor_cents: i64,
}

impl ReminderFacts {
    fn is_valid(&self) -> bool {
        month_index(&self.month).is_ok()
            && self.due_cents >= 0
            && (0..=MAX_CENTS).contains(&self.warning_floor_cents)
    }
}

#[tauri::command]
pub(crate) async fn ai_test_key(app: AppHandle) -> Result<(), String> {
    DeepSeek::official()?
        .test_key(&credentials::load(&app)?)
        .await
}

#[tauri::command]
pub(crate) fn ai_cancel(requests: State<'_, AiRequests>, request_id: String) -> Result<(), String> {
    requests.cancel(&request_id)
}

#[tauri::command]
pub(crate) async fn ai_explain(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request_id: String,
    facts: ReminderFacts,
    language: String,
) -> Result<String, String> {
    if !facts.is_valid() || !matches!(language.as_str(), "zh-CN" | "en-US") {
        return Err("AI_INVALID_INPUT".into());
    }
    requests
        .run(request_id, async move {
            let key = credentials::load(&app)?;
            let system = format!("{REMINDER}\n回复语言 / Response language: {language}");
            let input = Value::String(json!(facts).to_string());
            let reply = DeepSeek::official()?
                .complete(&key, &system, input, "text", 250)
                .await?;
            if reply.chars().count() > 500 || reply.chars().any(char::is_numeric) {
                return Err("AI_BAD_RESPONSE".into());
            }
            Ok(reply)
        })
        .await
}

#[tauri::command]
pub(crate) async fn ai_recognize(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    images: State<'_, images::SelectedImage>,
    request_id: String,
    image_token: String,
    platform_name: Option<String>,
) -> Result<Value, String> {
    let platform = platform_name
        .as_deref()
        .map(crate::ledger::platform_name)
        .transpose()
        .map_err(|_| "AI_INVALID_INPUT")?
        .map(str::to_owned);
    let image = images.data_url(&image_token)?;
    requests
        .run(request_id, async move {
            let key = credentials::load(&app)?;
            recognize(&DeepSeek::official()?, &key, image, platform.as_deref()).await
        })
        .await
}

async fn recognize(
    provider: &DeepSeek,
    key: &str,
    image: String,
    platform: Option<&str>,
) -> Result<Value, String> {
    let instruction = "请读取这张账单截图，按约定的 JSON 格式生成待核对的草稿。";
    let text = match platform {
        Some(name) => format!("{instruction}\n{}", json!({ "selectedPlatform": name })),
        None => instruction.to_owned(),
    };
    let input = json!([
        {"type": "text", "text": text},
        {"type": "image_url", "image_url": {"url": image, "detail": "high"}}
    ]);
    let reply = provider
        .complete(key, VISION, input, "json_object", 4096)
        .await?;
    bill_drafts(&reply)
}

fn bill_drafts(reply: &str) -> Result<Value, String> {
    let mut output: Value = serde_json::from_str(reply).map_err(|_| "AI_BAD_RESPONSE")?;
    let drafts = output.get_mut("drafts").ok_or("AI_BAD_RESPONSE")?;
    let rows = drafts.as_array_mut().ok_or("AI_BAD_RESPONSE")?;
    for row in rows {
        // The existing readBillDrafts parser validates values; only candidate fields cross IPC.
        row.as_object_mut()
            .ok_or("AI_BAD_RESPONSE")?
            .retain(|field, _| {
                matches!(
                    field.as_str(),
                    "platformHint"
                        | "title"
                        | "month"
                        | "repaymentTimeText"
                        | "amountCents"
                        | "totalCents"
                        | "depositCents"
                        | "kind"
                        | "installmentCount"
                )
            });
    }
    Ok(json!({"drafts": drafts.take()}))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Scenario {
    start_month: Option<String>,
    amount_cents: Option<i64>,
    installment_count: Option<i64>,
}

fn scenario_terms(reply: &str) -> Result<Scenario, String> {
    let terms: Value = serde_json::from_str(reply).map_err(|_| "AI_BAD_RESPONSE")?;
    if ["startMonth", "amountCents", "installmentCount"]
        .iter()
        .any(|field| terms.get(field).is_none())
    {
        return Err("AI_BAD_RESPONSE".into());
    }
    Ok(Scenario {
        start_month: terms["startMonth"]
            .as_str()
            .filter(|month| month_index(month).is_ok())
            .map(str::to_owned),
        amount_cents: terms["amountCents"]
            .as_i64()
            .filter(|cents| (1..=MAX_CENTS).contains(cents)),
        installment_count: terms["installmentCount"]
            .as_i64()
            .filter(|n| (1..=120).contains(n)),
    })
}

#[tauri::command]
pub(crate) async fn ai_parse_scenario(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request_id: String,
    message: String,
    reference_month: String,
) -> Result<Scenario, String> {
    if month_index(&reference_month).is_err()
        || !(1..=1000).contains(&message.trim().chars().count())
    {
        return Err("AI_INVALID_INPUT".into());
    }
    requests
        .run(request_id, async move {
            let key = credentials::load(&app)?;
            let input =
                json!({"message": message.trim(), "referenceMonth": reference_month}).to_string();
            let reply = DeepSeek::official()?
                .complete(&key, SCENARIO, Value::String(input), "json_object", 200)
                .await?;
            scenario_terms(&reply)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshots_return_only_candidate_fields_and_require_complete_json() {
        assert_eq!(bill_drafts(r#"{"drafts":[{"platformHint":"demo","status":"paid","id":"guessed","month":null}],"other":"private"}"#).unwrap(),
            json!({"drafts":[{"platformHint":"demo","month":null}]}));
        let deposit = json!({"drafts":[{"kind":"estimate","totalCents":10900,"depositCents":900,"amountCents":10000}]});
        assert_eq!(bill_drafts(&deposit.to_string()).unwrap(), deposit);
        assert_eq!(
            bill_drafts(r#"{"drafts":[]}"#).unwrap(),
            json!({"drafts":[]})
        );
        for bad in [" ", "{}", "[]", "42", r#"{"drafts":[1]}"#, r#"{"drafts":["#] {
            assert_eq!(bill_drafts(bad).unwrap_err(), "AI_BAD_RESPONSE");
        }
    }

    #[test]
    fn screenshots_keep_each_bills_repayment_time_even_if_month_is_missing() {
        let expected = json!({"drafts": [
            {"title": "画册", "month": null, "repaymentTimeText": "预计2026.11到货补款"},
            {"title": "徽章", "month": null, "repaymentTimeText": "预计2027.01到货补款"},
            {"title": "模型", "month": null, "repaymentTimeText": "预计2027.03到货补款"}
        ]});
        let mut reply = expected.clone();
        reply["drafts"][0]["purchaseTimeText"] = json!("2026.09 下单");
        reply["drafts"][1]["orderId"] = json!("synthetic-order");
        reply["drafts"][2]["status"] = json!("paid");
        assert_eq!(bill_drafts(&reply.to_string()).unwrap(), expected);
    }

    #[test]
    fn invalid_or_unknown_scenario_terms_remain_editable() {
        let terms =
            scenario_terms(r#"{"startMonth":"2099-12","amountCents":3250,"installmentCount":6}"#)
                .unwrap();
        assert_eq!(
            (
                terms.start_month.as_deref(),
                terms.amount_cents,
                terms.installment_count
            ),
            (Some("2099-12"), Some(3250), Some(6))
        );
        let terms =
            scenario_terms(r#"{"startMonth":"2100-01","amountCents":12.5,"installmentCount":121}"#)
                .unwrap();
        assert!(
            terms.start_month.is_none()
                && terms.amount_cents.is_none()
                && terms.installment_count.is_none()
        );
        assert!(scenario_terms("{}").is_err());
    }
}
