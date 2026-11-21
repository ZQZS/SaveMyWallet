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
    assert!(parse_reply(&raw, ChatMode::Pet, "en-US", &[]).is_err());
    let parsed = parse_reply(&raw, ChatMode::Pet, "en-US", &inspect).unwrap();
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
            "en-US",
            &tools
        )
        .is_err());
    }
    assert!(parse_reply(
        &reply("length", json!("incomplete"), json!([wire_call("partial")])),
        ChatMode::General,
        "en-US",
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
    let text = "Part of a longer story. ".repeat(700);
    let answer = reply("stop", json!(text), Value::Null);
    assert!(parse_reply(&answer, ChatMode::Pet, "en-US", &[]).is_err());
    let parsed = parse_reply(&answer, ChatMode::General, "en-US", &[]).unwrap();
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
    assert!(system.contains("Device local time: "));
    assert!(!system.contains("dueCents"));
    let last: Value = serde_json::from_str(messages[3]["content"].as_str().unwrap()).unwrap();
    assert_eq!(last, json!({"message":"How would it end?"}));
    assert!(chat_messages(ChatMode::Pet, None, &history, "en-US", None, None, true).is_err());
}

#[test]
fn menu_persona_uses_the_selected_card_as_user_context_for_long_form_chat() {
    let profile: ChatCharacter = serde_json::from_value(json!({
        "name":"小禾","description":"在海边看星星。".repeat(400),"voiceSample":"我看看星图。",
        "opening":"今晚想看哪颗星？","scenario":"深夜的天文台。"
    }))
    .unwrap();
    let prompt = "Write the next chapter. ".repeat(150);
    let history = [question(&prompt)];
    let turns = chat_messages(
        ChatMode::Persona,
        Some(&profile),
        &history,
        "en-US",
        None,
        None,
        false,
    )
    .unwrap();
    let request = completion_body(ChatMode::Persona, turns, &[], &[]).unwrap();
    assert_eq!(request["max_tokens"], 16_384);
    let system = request["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("用户选择的角色"));
    assert!(!system.contains("简短、自然的纯文本"));
    assert!(!system.contains("天文台") && !system.contains("dueCents"));
    let input: Value =
        serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(input, json!({"message":prompt.trim(),"character":profile}));
    for mode in [ChatMode::Pet, ChatMode::General] {
        assert!(chat_messages(mode, Some(&profile), &history, "en-US", None, None, false).is_err());
    }
    assert!(chat_messages(
        ChatMode::Persona,
        None,
        &history,
        "en-US",
        None,
        None,
        false
    )
    .is_err());
}

#[test]
fn menu_keeps_partial_prose_at_provider_limit_but_never_executes_incomplete_calls() {
    let raw = reply("length", json!("Chapter one…"), Value::Null);
    for mode in [ChatMode::General, ChatMode::Persona] {
        for (language, hint) in [("en-US", "continue"), ("zh-CN", "继续")] {
            let parsed = parse_reply(&raw, mode, language, &[]).unwrap();
            assert!(parsed.text.starts_with("Chapter one…") && parsed.text.contains(hint));
            assert!(parsed.calls.is_empty());
        }
        let partial_call = reply(
            "length",
            json!("Chapter one…"),
            json!([wire_call("partial")]),
        );
        assert!(parse_reply(&partial_call, mode, "en-US", &offered_tools(true, true)).is_err());
    }
    assert!(parse_reply(&raw, ChatMode::Pet, "en-US", &[]).is_err());
}

#[test]
fn menu_history_accepts_sixteen_complete_turns_and_checks_the_total_unicode_budget() {
    let user = "🦊".repeat(4096);
    let build = |answer_size: usize| {
        let mut messages = Vec::new();
        for _ in 0..16 {
            messages.push(question(&user));
            messages.push(ChatMessage {
                role: Role::Assistant,
                content: "猫".repeat(answer_size),
            });
        }
        messages.push(question("继续"));
        messages
    };
    let general = |history: &[ChatMessage]| {
        chat_messages(ChatMode::General, None, history, "zh-CN", None, None, false)
    };
    assert!(general(&build(4095)).is_ok());
    assert!(general(&build(4096)).is_err());
    assert!(general(&[question(&"🦊".repeat(32_768))]).is_ok());
    assert!(general(&[question(&"🦊".repeat(32_769))]).is_err());
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
    for name in [
        "manage_reminder",
        "show_pet_popup",
        "send_pet_notification",
        "schedule_pet_popup",
        "schedule_pet_notification",
    ] {
        assert!(names.contains(&name));
    }
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
    let reminder = wire("schedule_pet_popup", json!({"delaySeconds":600}));
    let manage = wire(
        "manage_reminder",
        json!({"operation":"disable","taskId":12}),
    );
    for mode in [ChatMode::General, ChatMode::Persona, ChatMode::Pet] {
        assert!(parse_reply(&manage, mode, "en-US", &no_rows).is_ok());
        assert!(parse_reply(&manage, mode, "en-US", &read_only).is_err());
    }
    assert!(parse_reply(&reminder, ChatMode::Pet, "en-US", &no_rows).is_ok());
    assert!(parse_reply(&reminder, ChatMode::Pet, "en-US", &read_only).is_err());
    for name in ["show_pet_popup", "send_pet_notification"] {
        let test = wire(name, json!({"testOnly":true,"text":"吃饭"}));
        assert!(parse_reply(&test, ChatMode::Pet, "en-US", &no_rows).is_ok());
    }
    for args in [
        json!({"recurrence":{"frequency":"monthly","dayOfMonth":10,"time":"09:00"},"text":"还款"}),
        json!({"recurrence":{"frequency":"interval","minutes":20},"text":"喝水"}),
        json!({"recurrence":{"frequency":"randomWindow","startTime":"22:00","endTime":"23:00"},"text":"睡觉"}),
    ] {
        let call = wire("schedule_pet_notification", args.clone());
        for mode in [ChatMode::General, ChatMode::Persona, ChatMode::Pet] {
            let accepted = parse_reply(&call, mode, "en-US", &no_rows).unwrap();
            assert_eq!(accepted.calls[0].arguments, args);
        }
    }
    assert!(parse_reply(&action, ChatMode::General, "en-US", &read_only).is_err());
    assert!(parse_reply(&action, ChatMode::General, "en-US", &no_rows).is_err());
    let accepted = parse_reply(&action, ChatMode::General, "en-US", &all).unwrap();
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
        wire(
            "schedule_pet_notification",
            json!({"delaySeconds":600,"testOnly":true}),
        ),
        wire("void_bills", json!("all")),
        wire(
            "send_pet_notification",
            json!({"recurrence":{"frequency":"daily","time":"09:00"}}),
        ),
        wire(
            "schedule_pet_popup",
            json!({"recurrence":{"frequency":"interval","minutes":20,"anchorAt":1}}),
        ),
        wire(
            "schedule_pet_notification",
            json!({"recurrence":{"frequency":"randomWindow","startTime":"11:30","endTime":"13:00","seed":42}}),
        ),
    ] {
        assert!(parse_reply(&invalid, ChatMode::Pet, "en-US", &all).is_err());
    }
    let body = completion_body(ChatMode::General, vec![], &all, &[]).unwrap();
    assert!(body["tools"].as_array().unwrap().iter().all(|tool| {
        tool["function"].get("requiresSelection").is_none()
            && tool["function"]["parameters"]["type"] == "object"
    }));
}
