use super::{
    chat_messages, credentials, AiRequests, ChatCharacter, ChatMessage, ChatMode, ChatMonthDetails,
    DeepSeek, ReminderFacts, INVALID_INPUT,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::LazyLock;
use tauri::{AppHandle, State};

const INSPECT: &str = "inspect_selected_bills";
const MAX_TOOL_ROUNDS: usize = 4;
const BAD_REPLY: &str = "AI_BAD_RESPONSE";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolDefinition {
    name: String,
    description: String,
    parameters: Value,
    #[serde(skip_serializing)]
    requires_selection: bool,
}

static ACTIONS: LazyLock<Vec<ToolDefinition>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../resources/ai/ledger-action-tools.json"
    ))
    .expect("bundled ledger action definitions must be valid")
});

static INSPECT_TOOL: LazyLock<ToolDefinition> = LazyLock::new(|| ToolDefinition {
    name: INSPECT.into(),
    description: "查看本轮勾选的账单、行号、已确认待还合计与最大项。行号仅适用于本轮选择。".into(),
    parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
    requires_selection: true,
});

fn offered_tools(has_selection: bool, actions_enabled: bool) -> Vec<&'static ToolDefinition> {
    let mut tools = Vec::new();
    if has_selection {
        tools.push(&*INSPECT_TOOL);
    }
    if actions_enabled {
        tools.extend(
            ACTIONS
                .iter()
                .filter(|tool| has_selection || !tool.requires_selection),
        );
    }
    tools
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolCall {
    id: String,
    name: String,
    arguments: Value,
}

impl ToolCall {
    fn is_offered(&self, tools: &[&ToolDefinition]) -> bool {
        let Some(tool) = tools.iter().find(|tool| tool.name == self.name) else {
            return false;
        };
        let Some(args) = self.arguments.as_object() else {
            return false;
        };
        // Pi validates schema types and the application validates business rules before
        // presenting a preview. The provider transport accepts only declared argument names.
        !self.id.trim().is_empty()
            && self.id.len() <= 256
            && declared_fields(args, &tool.parameters)
    }
}

fn declared_fields(args: &serde_json::Map<String, Value>, schema: &Value) -> bool {
    let Some(properties) = schema["properties"].as_object() else {
        return false;
    };
    args.iter().all(|(key, value)| {
        properties.get(key).is_some_and(|field| {
            value
                .as_object()
                .is_none_or(|nested| declared_fields(nested, field))
        })
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolResult {
    id: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolRound {
    text: String,
    calls: Vec<ToolCall>,
    results: Vec<ToolResult>,
}

#[derive(Serialize)]
pub(crate) struct AgentReply {
    text: String,
    calls: Vec<ToolCall>,
}

fn tool_calls_valid(calls: &[ToolCall], tools: &[&ToolDefinition]) -> bool {
    let mut ids = HashSet::new();
    !calls.is_empty()
        && calls
            .iter()
            .all(|call| call.is_offered(tools) && ids.insert(&call.id))
}

fn completion_body(
    mode: ChatMode,
    mut messages: Vec<Value>,
    tools: &[&ToolDefinition],
    rounds: &[ToolRound],
) -> Result<Value, String> {
    if rounds.len() > MAX_TOOL_ROUNDS {
        return Err(INVALID_INPUT.into());
    }
    for round in rounds {
        // Write outcomes are shown as local receipts. Only a read-only tool may
        // send its selected-row result back to the provider for a follow-up.
        if round.calls.iter().any(|call| call.name != INSPECT)
            || !tool_calls_valid(&round.calls, tools)
            || round.text.chars().count() > mode.max_reply_chars()
            || round.results.len() != round.calls.len()
        {
            return Err(INVALID_INPUT.into());
        }
        let mut calls = Vec::with_capacity(round.calls.len());
        for (call, result) in round.calls.iter().zip(&round.results) {
            if result.id != call.id || result.content.trim().is_empty() {
                return Err(INVALID_INPUT.into());
            }
            calls.push(json!({
                "id":call.id, "type":"function",
                "function":{"name":call.name,"arguments":call.arguments.to_string()}
            }));
        }
        messages.push(json!({"role":"assistant","content":round.text,"tool_calls":calls}));
        for result in &round.results {
            messages.push(json!({"role":"tool","tool_call_id":result.id,"content":result.content}));
        }
    }
    let max_tokens = match mode {
        ChatMode::Pet => 600,
        ChatMode::General => 1800,
    };
    let mut body =
        json!({"model":"deepseek-flash","thinking":{"type":"disabled"},"max_tokens":max_tokens});
    body["messages"] = Value::Array(messages);
    if !tools.is_empty() {
        body["tools"] = tools
            .iter()
            .map(|tool| json!({"type":"function","function":tool}))
            .collect();
        if rounds.len() == MAX_TOOL_ROUNDS {
            body["tool_choice"] = json!("none");
        }
    }
    Ok(body)
}

fn parse_reply(
    raw: &Value,
    mode: ChatMode,
    tools: &[&ToolDefinition],
) -> Result<AgentReply, String> {
    let choice = &raw["choices"][0];
    let message = &choice["message"];
    let text = match &message["content"] {
        Value::String(text) => text.trim(),
        Value::Null => "",
        _ => return Err(BAD_REPLY.into()),
    };
    if text.chars().count() > mode.max_reply_chars() {
        return Err(BAD_REPLY.into());
    }
    let mut calls = Vec::new();
    match choice["finish_reason"].as_str() {
        Some("stop")
            if !text.is_empty() && message["tool_calls"].as_array().is_none_or(Vec::is_empty) => {}
        Some("tool_calls") if !tools.is_empty() => {
            for call in message["tool_calls"].as_array().ok_or(BAD_REPLY)? {
                if call["type"] != "function" {
                    return Err(BAD_REPLY.into());
                }
                let function = &call["function"];
                calls.push(ToolCall {
                    id: call["id"].as_str().ok_or(BAD_REPLY)?.to_owned(),
                    name: function["name"].as_str().ok_or(BAD_REPLY)?.to_owned(),
                    arguments: serde_json::from_str(
                        function["arguments"].as_str().ok_or(BAD_REPLY)?,
                    )
                    .map_err(|_| BAD_REPLY)?,
                });
            }
            if !tool_calls_valid(&calls, tools) {
                return Err(BAD_REPLY.into());
            }
        }
        _ => return Err(BAD_REPLY.into()),
    }
    Ok(AgentReply {
        text: text.to_owned(),
        calls,
    })
}

#[tauri::command]
pub(crate) async fn ai_agent_chat_turn(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request_id: String,
    mode: ChatMode,
    character: Option<ChatCharacter>,
    messages: Vec<ChatMessage>,
    language: String,
    facts: Option<ReminderFacts>,
    details: Option<ChatMonthDetails>,
    tool_rounds: Vec<ToolRound>,
    action_tools_enabled: Option<bool>,
) -> Result<AgentReply, String> {
    if details
        .as_ref()
        .is_some_and(|rows| !rows.is_valid_for(facts.as_ref()))
    {
        return Err(INVALID_INPUT.into());
    }
    // The selected rows stay on the device until the model actually requests the tool.
    let actions_enabled = action_tools_enabled.unwrap_or(false);
    let turns = chat_messages(
        mode,
        character.as_ref(),
        &messages,
        &language,
        facts.as_ref(),
        None,
        actions_enabled,
    )?;
    let mut tools = offered_tools(details.is_some(), actions_enabled);
    let body = completion_body(mode, turns, &tools, &tool_rounds)?;
    if tool_rounds.len() == MAX_TOOL_ROUNDS {
        tools.clear();
    }
    requests
        .run(request_id, async move {
            let key = credentials::load(&app)?;
            let raw = DeepSeek::official()?.post_completion(&key, &body).await?;
            parse_reply(&raw, mode, &tools)
        })
        .await
}

#[cfg(test)]
mod tests;
