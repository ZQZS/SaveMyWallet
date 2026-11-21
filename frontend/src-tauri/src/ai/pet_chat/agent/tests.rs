use super::*;
use crate::ai::pet_chat::Role;

fn question(text: &str) -> ChatMessage {
    ChatMessage {
        role: Role::User,
        content: text.into(),
    }
}

fn wire_call(id: &str) -> Value {
    json!({"id":id,"type":"function","function":{"name":INSPECT,"arguments":"{}"}})
}

fn reply(reason: &str, content: Value, calls: Value) -> Value {
    json!({"choices":[{"finish_reason":reason,"message":{"content":content,"tool_calls":calls}}]})
}

#[test]
fn exposes_only_the_chosen_tool_and_replays_its_result_with_the_same_id() {
    let user = vec![json!({"role":"user","content":"哪些勾选的账单未还？"})];
    let inspect = offered_tools(true, false);
    let plain = completion_body(ChatMode::General, user.clone(), &[], &[]).unwrap();
    assert!(plain.get("tools").is_none());
    let first = completion_body(ChatMode::Pet, user.clone(), &inspect, &[]).unwrap();
    assert_eq!(first["thinking"], json!({"type":"disabled"}));
    assert_eq!(first["tools"][0]["function"]["name"], INSPECT);
    let call = wire_call("call_0");
    let raw = reply("tool_calls", Value::Null, json!([call]));
    assert!(parse_reply(&raw, ChatMode::Pet, &[]).is_err());
    let parsed = parse_reply(&raw, ChatMode::Pet, &inspect).unwrap();
    let payload = json!({"dueCount":1,"dueCents":2500,"largestDue":{"amountCents":2500,"bills":[{"title":"测试","platform":"示例"}]}}).to_string();
    let round = ToolRound {
        text: parsed.text,
        calls: parsed.calls,
        results: vec![ToolResult {
            id: "call_0".into(),
            content: payload.clone(),
        }],
    };
    let completed = completion_body(
        ChatMode::Pet,
        user.clone(),
        &inspect,
        std::slice::from_ref(&round),
    )
    .unwrap();
    assert_eq!(completed["messages"][1]["tool_calls"][0], call);
    assert_eq!(
        completed["messages"][2],
        json!({"role":"tool","tool_call_id":"call_0","content":payload})
    );
    // No tool result (including one retained from another turn) can be sent without a selection.
    assert!(completion_body(ChatMode::Pet, user, &[], &[round]).is_err());
}

#[test]
fn rejects_broken_or_unoffered_tool_calls_and_truncated_model_output() {
    let tools = offered_tools(true, false);
    let valid = wire_call("id_0");
    let mut invalid = valid.clone();
    invalid["function"]["arguments"] = json!(r#"{"platform":"all"}"#);
    for calls in [
        json!([]),
        json!([valid, valid]),
        json!([invalid]),
        json!([wire_call("")]),
    ] {
        assert!(parse_reply(
            &reply("tool_calls", Value::Null, calls),
            ChatMode::General,
            &tools
        )
        .is_err());
    }
    assert!(parse_reply(
        &reply("length", json!("incomplete"), Value::Null),
        ChatMode::General,
        &[]
    )
    .is_err());
    let mismatched: ToolRound = serde_json::from_value(json!({
        "text":"","calls":[{"name":INSPECT,"arguments":{},"id":"id_1"}],"results":[{"id":"id_0","content":"{}"}]
    })).unwrap();
    assert!(completion_body(ChatMode::Pet, vec![], &tools, &[mismatched]).is_err());
}

#[test]
fn general_chat_handles_long_replies_and_their_followups_without_persona_or_ledger_context() {
    let text = "hello ".repeat(550);
    let answer = reply("stop", json!(text), Value::Null);
    assert!(parse_reply(&answer, ChatMode::Pet, &[]).is_err());
    let parsed = parse_reply(&answer, ChatMode::General, &[]).unwrap();
    let history = vec![
        question("Write a story."),
        ChatMessage {
            role: Role::Assistant,
            content: parsed.text,
        },
        question("How would it end?"),
    ];
    let messages =
        chat_messages(ChatMode::General, None, &history, "en-US", None, None, true).unwrap();
    let system = messages[0]["content"].as_str().unwrap();
    assert!(system.contains("通用聊天助手"));
    assert!(!system.contains("dueCents"));
    let last: Value = serde_json::from_str(messages[3]["content"].as_str().unwrap()).unwrap();
    assert_eq!(last, json!({"message":"How would it end?"}));
    assert!(chat_messages(ChatMode::Pet, None, &history, "en-US", None, None, true).is_err());
}

#[test]
fn action_tools_are_offered_by_scope_and_only_declared_calls_return_to_pi() {
    let read_only = offered_tools(true, false);
    let no_rows = offered_tools(false, true);
    let all = offered_tools(true, true);
    let names: Vec<_> = no_rows.iter().map(|tool| tool.name.as_str()).collect();
    assert!(names.contains(&"create_platform"));
    assert!(names.contains(&"create_bill"));
    assert!(names.contains(&"update_budget"));
    assert!(!names.contains(&"mark_bills_paid"));
    assert!(!names.contains(&INSPECT));
    let wire = |name, args: Value| {
        reply(
            "tool_calls",
            Value::Null,
            json!([{
                "id":"change_1","type":"function","function":{"name":name,"arguments":args.to_string()}
            }]),
        )
    };
    let action = wire("mark_bills_paid", json!({"rows":[1]}));
    assert!(parse_reply(&action, ChatMode::General, &read_only).is_err());
    assert!(parse_reply(&action, ChatMode::General, &no_rows).is_err());
    let accepted = parse_reply(&action, ChatMode::General, &all).unwrap();
    assert_eq!(accepted.calls[0].arguments, json!({"rows":[1]}));
    let receipt = ToolRound {
        text: String::new(),
        calls: accepted.calls,
        results: vec![ToolResult {
            id: "change_1".into(),
            content: "private local receipt".into(),
        }],
    };
    assert!(completion_body(ChatMode::Pet, vec![], &all, &[receipt]).is_err());
    for invalid in [
        wire("mark_bills_paid", json!({"ids":["private-id"]})),
        wire("reset_ledger", json!({})),
        wire("void_bills", json!("all")),
    ] {
        assert!(parse_reply(&invalid, ChatMode::Pet, &all).is_err());
    }
    let body = completion_body(ChatMode::General, vec![], &all, &[]).unwrap();
    assert!(body["tools"].as_array().unwrap().iter().all(|tool| {
        tool["function"].get("requiresSelection").is_none()
            && tool["function"]["parameters"]["type"] == "object"
    }));
}
