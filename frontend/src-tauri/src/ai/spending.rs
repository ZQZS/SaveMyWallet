use super::{credentials, deepseek::DeepSeek, AiRequests};
use crate::ledger::bill_title;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, State};

const PROMPT: &str = include_str!("../../../resources/ai/prompts/spending.md");
const MAX_TITLES: usize = 40;

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SpendingCategory {
    Food,
    Transport,
    Housing,
    Shopping,
    Health,
    Education,
    Gaming,
    Merchandise,
    Leisure,
    Other,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assignment {
    index: usize,
    category: SpendingCategory,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Classifications {
    items: Vec<Assignment>,
}

fn classification_input(titles: &[String]) -> Result<Value, String> {
    if !(1..=MAX_TITLES).contains(&titles.len()) {
        return Err("AI_INVALID_INPUT".into());
    }
    let mut seen = HashSet::with_capacity(titles.len());
    let mut items = Vec::with_capacity(titles.len());
    for (index, title) in titles.iter().enumerate() {
        let title = bill_title(title).map_err(|_| "AI_INVALID_INPUT")?;
        if !seen.insert(title) {
            return Err("AI_INVALID_INPUT".into());
        }
        items.push(json!({ "index": index, "title": title }));
    }
    Ok(Value::String(json!({ "items": items }).to_string()))
}

fn parse_categories(reply: &str, count: usize) -> Result<Vec<SpendingCategory>, String> {
    let Classifications { mut items } =
        serde_json::from_str(reply).map_err(|_| "AI_BAD_RESPONSE")?;
    items.sort_unstable_by_key(|item| item.index);
    if items.len() != count || items.iter().enumerate().any(|(i, item)| i != item.index) {
        return Err("AI_BAD_RESPONSE".into());
    }
    Ok(items.into_iter().map(|item| item.category).collect())
}

#[tauri::command]
pub(crate) async fn ai_classify_spending(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request_id: String,
    titles: Vec<String>,
) -> Result<Vec<SpendingCategory>, String> {
    let input = classification_input(&titles)?;
    let count = titles.len();
    requests
        .run(request_id, async move {
            let key = credentials::load(&app)?;
            let reply = DeepSeek::official()?
                .complete(&key, PROMPT, input, "json_object", 1536)
                .await?;
            parse_categories(&reply, count)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_only_normalized_names_and_batch_indices() {
        let name = "书名含 \"双引号\" 和换行\n下册";
        let input = classification_input(&["  午餐  ".into(), name.into()]).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(input.as_str().unwrap()).unwrap(),
            json!({ "items": [{ "index": 0, "title": "午餐" }, { "index": 1, "title": name }] })
        );
        let mut full: Vec<String> = (0..MAX_TITLES).map(|i| format!("书{i}")).collect();
        assert!(classification_input(&full).is_ok());
        full.push("第 41 项".into());
        for invalid in [
            vec![],
            vec![" ".into()],
            vec!["书".repeat(121)],
            vec!["书".into(), " 书 ".into()],
            full,
        ] {
            assert_eq!(
                classification_input(&invalid).unwrap_err(),
                "AI_INVALID_INPUT"
            );
        }
    }

    #[test]
    fn returns_one_supported_category_per_name_in_input_order() {
        let second = json!({"index": 1, "category": "other"});
        let first = json!({"index": 0, "category": "food"});
        let reply = json!({"items":[second, first]}).to_string();
        assert_eq!(
            parse_categories(&reply, 2).unwrap(),
            [SpendingCategory::Food, SpendingCategory::Other]
        );
        for invalid in [
            json!({"items":[first]}),
            json!({"items":[first, first]}),
            json!({"items":[first, second, second]}),
            json!({"items":[first, {"index":2,"category":"other"}]}),
            json!({"items":[first, {"index":-1,"category":"other"}]}),
            json!({"items":[first, {"index":1,"category":"made-up"}]}),
            json!({"items":[first, {"index":1,"category":"food","amount":100}]}),
        ] {
            assert_eq!(
                parse_categories(&invalid.to_string(), 2).unwrap_err(),
                "AI_BAD_RESPONSE"
            );
        }
    }

    #[test]
    fn keeps_gaming_and_merchandise_distinct_from_leisure_and_shopping_over_ipc() {
        let expected = ["gaming", "merchandise", "leisure", "shopping"];
        let items: Vec<_> = expected
            .iter()
            .enumerate()
            .map(|(index, category)| json!({ "index": index, "category": category }))
            .collect();
        let reply = json!({ "items": items }).to_string();
        let categories = parse_categories(&reply, expected.len()).unwrap();
        assert_eq!(serde_json::to_value(categories).unwrap(), json!(expected));
    }
}
