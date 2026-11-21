use super::{credentials, deepseek::DeepSeek, images::SelectedImage, AiRequests};
use crate::ledger::{month_index, MAX_CENTS};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

const NOTICE: &str = include_str!("../../../resources/ai/prompts/notice.md");
const SEARCH: &str = include_str!("../../../resources/ai/prompts/search.md");
const BAD_RESPONSE: &str = "AI_BAD_RESPONSE";
const INVALID_INPUT: &str = "AI_INVALID_INPUT";

// A model must explicitly return null for unknown values. Missing fields indicate a broken reply.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Notice {
    #[serde(deserialize_with = "nullable")]
    platform_hint: Option<String>,
    #[serde(deserialize_with = "nullable")]
    title: Option<String>,
    #[serde(deserialize_with = "nullable")]
    month: Option<String>,
    #[serde(deserialize_with = "nullable")]
    amount_cents: Option<i64>,
    #[serde(deserialize_with = "nullable")]
    total_cents: Option<i64>,
    #[serde(deserialize_with = "nullable")]
    deposit_cents: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Estimate,
    Installment,
    Single,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Estimated,
    Due,
    Paid,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Voided {
    Active,
    Voided,
    All,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SearchFilters {
    supported: bool,
    #[serde(deserialize_with = "nullable")]
    from_month: Option<String>,
    #[serde(deserialize_with = "nullable")]
    to_month: Option<String>,
    #[serde(deserialize_with = "nullable")]
    platform: Option<String>,
    #[serde(deserialize_with = "nullable")]
    title: Option<String>,
    #[serde(deserialize_with = "nullable")]
    kind: Option<Kind>,
    statuses: Vec<Status>,
    #[serde(deserialize_with = "nullable")]
    has_deposit: Option<bool>,
    outstanding_only: bool,
    voided: Voided,
}

fn valid_label(value: Option<&str>, limit: usize) -> bool {
    value.map_or(true, |s| {
        !s.trim().is_empty() && s.chars().count() <= limit && !s.chars().any(char::is_control)
    })
}

fn parse_notice(reply: &str) -> Result<Notice, String> {
    let notice: Notice = serde_json::from_str(reply).map_err(|_| BAD_RESPONSE)?;
    let amounts = [
        notice.amount_cents,
        notice.total_cents,
        notice.deposit_cents,
    ];
    let labels = [&notice.platform_hint, &notice.title, &notice.month];
    if (labels.iter().all(|v| v.is_none()) && amounts.iter().all(Option::is_none))
        || !valid_label(notice.platform_hint.as_deref(), 40)
        || !valid_label(notice.title.as_deref(), 120)
        || notice
            .month
            .as_deref()
            .is_some_and(|m| month_index(m).is_err())
        || amounts
            .into_iter()
            .flatten()
            .any(|v| !(0..=MAX_CENTS).contains(&v))
        || notice.total_cents == Some(0)
    {
        return Err(BAD_RESPONSE.into());
    }
    Ok(notice)
}

fn parse_search(reply: &str) -> Result<SearchFilters, String> {
    let mut filters: SearchFilters = serde_json::from_str(reply).map_err(|_| BAD_RESPONSE)?;
    let from = filters.from_month.as_deref();
    let to = filters.to_month.as_deref();
    if [from, to]
        .into_iter()
        .flatten()
        .any(|m| month_index(m).is_err())
        || from.zip(to).is_some_and(|(start, end)| start > end)
        || !valid_label(filters.platform.as_deref(), 40)
        || !valid_label(filters.title.as_deref(), 120)
        || filters.statuses.len() > 3
        || filters
            .statuses
            .iter()
            .enumerate()
            .any(|(index, s)| filters.statuses[..index].contains(s))
    {
        return Err(BAD_RESPONSE.into());
    }
    filters.supported &= from.is_some()
        || to.is_some()
        || filters.platform.is_some()
        || filters.title.is_some()
        || filters.kind.is_some()
        || !filters.statuses.is_empty()
        || filters.has_deposit.is_some()
        || filters.outstanding_only
        || filters.voided != Voided::Active;
    Ok(filters)
}

fn text_input(message: &str, reference_month: &str, limit: usize) -> Result<Value, String> {
    let message = message.trim();
    if !(1..=limit).contains(&message.chars().count()) {
        return Err(INVALID_INPUT.into());
    }
    Ok(Value::String(
        json!({"message":message,"referenceMonth":reference_month}).to_string(),
    ))
}

fn notice_input(
    message: Option<&str>,
    image_token: Option<&str>,
    reference_month: &str,
    images: &SelectedImage,
) -> Result<Value, String> {
    match (message, image_token) {
        (Some(text), None) => text_input(text, reference_month, 4000),
        (None, Some(token)) => Ok(json!([
            {"type":"text","text":json!({"referenceMonth":reference_month}).to_string()},
            {"type":"image_url","image_url":{"url":images.data_url(token)?,"detail":"high"}}
        ])),
        _ => Err(INVALID_INPUT.into()),
    }
}

async fn extract<T: Send + 'static>(
    app: AppHandle,
    requests: &AiRequests,
    request_id: String,
    instruction: &'static str,
    input: Value,
    parse: fn(&str) -> Result<T, String>,
) -> Result<T, String> {
    requests
        .run(request_id, async move {
            let key = credentials::load(&app)?;
            let reply = DeepSeek::official()?
                .complete(&key, instruction, input, "json_object", 512)
                .await?;
            parse(&reply)
        })
        .await
}

#[tauri::command]
pub(crate) async fn ai_parse_notice(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    images: State<'_, SelectedImage>,
    request_id: String,
    message: Option<String>,
    image_token: Option<String>,
    reference_month: String,
) -> Result<Notice, String> {
    month_index(&reference_month).map_err(|_| INVALID_INPUT)?;
    let input = notice_input(
        message.as_deref(),
        image_token.as_deref(),
        &reference_month,
        &images,
    )?;
    extract(app, &requests, request_id, NOTICE, input, parse_notice).await
}

#[tauri::command]
pub(crate) async fn ai_parse_search(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request_id: String,
    message: String,
    reference_month: String,
) -> Result<SearchFilters, String> {
    month_index(&reference_month).map_err(|_| INVALID_INPUT)?;
    let input = text_input(&message, &reference_month, 1000)?;
    extract(app, &requests, request_id, SEARCH, input, parse_search).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice() -> Value {
        json!({"platformHint":null,"title":null,"month":null,"amountCents":null,
            "totalCents":null,"depositCents":null})
    }

    fn search() -> Value {
        json!({"supported":true,"fromMonth":null,"toMonth":null,"platform":null,"title":null,
            "kind":null,"statuses":[],"hasDeposit":null,"outstandingOnly":false,"voided":"active"})
    }

    #[test]
    fn preserves_explicit_notice_amounts_and_missing_fields() {
        let mut data = notice();
        data["amountCents"] = json!(0);
        let parsed = parse_notice(&data.to_string()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), data);
        data["amountCents"] = json!(3200);
        data["depositCents"] = json!(500);
        data["totalCents"] = json!(4000);
        let parsed = parse_notice(&data.to_string()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), data);
    }

    #[test]
    fn rejects_empty_malformed_or_out_of_range_notices() {
        assert_eq!(
            parse_notice(&notice().to_string()).unwrap_err(),
            BAD_RESPONSE
        );
        for (field, invalid) in [
            ("month", json!("2026-13")),
            ("month", json!("2100-01")),
            ("amountCents", json!(3.14)),
            ("amountCents", json!("20")),
            ("totalCents", json!(0)),
            ("totalCents", json!(MAX_CENTS + 1)),
            ("depositCents", json!(-1)),
            ("platformHint", json!("台".repeat(41))),
            ("title", json!("two\nlines")),
            ("orderId", json!("unrelated")),
        ] {
            let mut data = notice();
            data[field] = invalid;
            assert_eq!(
                parse_notice(&data.to_string()).unwrap_err(),
                BAD_RESPONSE,
                "{field}"
            );
        }
        let mut data = notice();
        data["title"] = json!("画册");
        data.as_object_mut().unwrap().remove("depositCents");
        assert_eq!(parse_notice(&data.to_string()).unwrap_err(), BAD_RESPONSE);
    }

    #[test]
    fn only_accepts_one_user_source_and_bounds_text_by_character() {
        let images = SelectedImage::default();
        let month = "2026-12";
        for (text, token) in [
            (None, None),
            (Some("notice"), Some("1")),
            (Some(" \n "), None),
        ] {
            assert_eq!(
                notice_input(text, token, month, &images).unwrap_err(),
                INVALID_INPUT
            );
        }
        assert_eq!(
            notice_input(None, Some("https://example.invalid/a.png"), month, &images).unwrap_err(),
            "AI_IMAGE_EXPIRED"
        );
        let input = notice_input(Some("  尾款 40 元  "), None, month, &images).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(input.as_str().unwrap()).unwrap(),
            json!({"message":"尾款 40 元","referenceMonth":"2026-12"})
        );
        let long = "款".repeat(4001);
        assert!(notice_input(Some(&long), None, month, &images).is_err());
        assert!(text_input(&"款".repeat(1000), month, 1000).is_ok());
        assert!(text_input(&"款".repeat(1001), month, 1000).is_err());
    }

    #[test]
    fn empty_or_unsupported_search_never_yields_broad_results() {
        let mut data = search();
        assert!(!parse_search(&data.to_string()).unwrap().supported);
        data["fromMonth"] = json!("2026-12");
        data["toMonth"] = json!("2027-01");
        data["supported"] = json!(false);
        assert!(!parse_search(&data.to_string()).unwrap().supported);
        data["supported"] = json!(true);
        data["kind"] = json!("estimate");
        data["statuses"] = json!(["estimated", "due"]);
        data["hasDeposit"] = json!(true);
        data["outstandingOnly"] = json!(true);
        assert_eq!(
            serde_json::to_value(parse_search(&data.to_string()).unwrap()).unwrap(),
            data
        );
        let mut data = search();
        data["hasDeposit"] = json!(false);
        assert!(parse_search(&data.to_string()).unwrap().supported);
        let mut data = search();
        data["voided"] = json!("all");
        assert!(parse_search(&data.to_string()).unwrap().supported);
    }

    #[test]
    fn invalid_filter_values_do_not_fall_back_to_defaults() {
        for (field, invalid) in [
            ("fromMonth", json!("2027-1")),
            ("toMonth", json!("2026-01")),
            ("kind", json!("refund")),
            ("statuses", json!(["due", "due"])),
            ("statuses", json!(["invalid"])),
            ("hasDeposit", json!("false")),
            ("title", json!(" ")),
            ("voided", json!(false)),
            ("minCents", json!(12000)),
        ] {
            let mut data = search();
            data["fromMonth"] = json!("2026-12");
            data[field] = invalid;
            assert_eq!(
                parse_search(&data.to_string()).unwrap_err(),
                BAD_RESPONSE,
                "{field}"
            );
        }
        let mut data = search();
        data["fromMonth"] = json!("2026-12");
        data.as_object_mut().unwrap().remove("hasDeposit");
        assert_eq!(parse_search(&data.to_string()).unwrap_err(), BAD_RESPONSE);
    }
}
