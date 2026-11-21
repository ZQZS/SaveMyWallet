use super::{credentials, deepseek::DeepSeek, AiRequests, ReminderFacts};
use crate::ledger::{bill_title, check_entry_amount, platform_name};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

const INTERACTION: &str = include_str!("../../../resources/ai/prompts/interaction.md");
const PERSONA_CHAT: &str = include_str!("../../../resources/ai/prompts/persona-chat.md");
const SHARED_LEDGER: &str = include_str!("../../../resources/ai/prompts/chat-ledger.md");
const LEDGER_ACTIONS: &str = include_str!("../../../resources/ai/prompts/chat-actions.md");
const GENERAL_CHAT: &str = "你是 SaveMyWallet 中的通用聊天助手。根据用户的问题自然地闲聊、解释、写作或协助完成其他话题。应用将用户本轮的文字放在最后一条用户消息的 JSON 字段 message 中。账本数据仅在用户主动分享时可用。";
const MAX_REPLY_CHARS: usize = 2000;
const MENU_INPUT_CHARS: usize = 32_768;
const MENU_CONTEXT_CHARS: usize = 131_072;
const INVALID_INPUT: &str = "AI_INVALID_INPUT";

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChatMode {
    Pet,
    General,
    Persona,
}

impl ChatMode {
    fn history_reply_limit(self) -> usize {
        if self == Self::Pet {
            MAX_REPLY_CHARS
        } else {
            MENU_CONTEXT_CHARS
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatCharacter {
    name: String,
    description: String,
    voice_sample: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    opening: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scenario: Option<String>,
}

impl ChatCharacter {
    fn is_valid_for(&self, mode: ChatMode) -> bool {
        let (description, sample, opening) = match mode {
            ChatMode::Persona => (16_384, 8_192, 8_192),
            _ => (2000, 500, 1000),
        };
        !self.name.trim().is_empty()
            && self.name.chars().count() <= 128
            && self.description.chars().count() <= description
            && self.voice_sample.chars().count() <= sample
            && self
                .scenario
                .as_ref()
                .is_none_or(|scene| mode == ChatMode::Persona && scene.chars().count() <= 8192)
            && self
                .opening
                .as_ref()
                .is_none_or(|line| line.chars().count() <= opening)
    }
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Role {
    User,
    Assistant,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChatMessage {
    role: Role,
    content: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatEntry {
    platform: String,
    title: String,
    kind: String,
    status: String,
    amount_cents: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    voided: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deposit_cents: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installment_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installment_count: Option<u32>,
}

impl ChatEntry {
    fn is_valid(&self) -> bool {
        let periods_valid = match (
            self.kind.as_str(),
            self.installment_index,
            self.installment_count,
        ) {
            ("installment", Some(index), Some(count)) => {
                (1..=120).contains(&count) && (1..=count).contains(&index)
            }
            ("single" | "estimate", None, None) => true,
            _ => false,
        };
        let status_valid = match self.status.as_str() {
            "estimated" => self.kind == "estimate",
            "due" => self.amount_cents > 0,
            "paid" => true,
            _ => false,
        };
        periods_valid
            && status_valid
            && platform_name(&self.platform).is_ok_and(|name| name == self.platform)
            && bill_title(&self.title).is_ok_and(|title| title == self.title)
            && check_entry_amount(
                &self.kind,
                self.amount_cents,
                self.deposit_cents.unwrap_or(0),
            )
            .is_ok()
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChatMonthDetails {
    month: String,
    entries: Vec<ChatEntry>,
}

impl ChatMonthDetails {
    fn is_valid_for(&self, facts: Option<&ReminderFacts>) -> bool {
        facts.is_some_and(|summary| self.month == summary.month)
            && !self.entries.is_empty()
            && self.entries.iter().all(ChatEntry::is_valid)
    }
}

fn provider_messages(
    character: &ChatCharacter,
    messages: &[ChatMessage],
    language: &str,
    facts: Option<&ReminderFacts>,
    details: Option<&ChatMonthDetails>,
) -> Result<Vec<Value>, String> {
    chat_messages(
        ChatMode::Pet,
        Some(character),
        messages,
        language,
        facts,
        details,
        false,
    )
}

fn chat_messages(
    mode: ChatMode,
    character: Option<&ChatCharacter>,
    messages: &[ChatMessage],
    language: &str,
    facts: Option<&ReminderFacts>,
    details: Option<&ChatMonthDetails>,
    actions_enabled: bool,
) -> Result<Vec<Value>, String> {
    let prompt = match (mode, character) {
        (ChatMode::Pet, Some(_)) => INTERACTION,
        (ChatMode::General, None) => GENERAL_CHAT,
        (ChatMode::Persona, Some(_)) => PERSONA_CHAT,
        _ => return Err(INVALID_INPUT.into()),
    };
    let pet = mode == ChatMode::Pet;
    let max_messages = if pet { 11 } else { 33 };
    if !matches!(language, "zh-CN" | "en-US")
        || character.is_some_and(|c| !c.is_valid_for(mode))
        || facts.is_some_and(|facts| !facts.is_valid())
        || details.is_some_and(|details| !details.is_valid_for(facts))
        || !(1..=max_messages).contains(&messages.len())
        || messages.len() % 2 == 0
    {
        return Err(INVALID_INPUT.into());
    }

    let ledger_context = if facts.is_some() { SHARED_LEDGER } else { "" };
    let actions = if actions_enabled { LEDGER_ACTIONS } else { "" };
    let mut system = format!("{prompt}\n{ledger_context}\n{actions}");
    if pet {
        system.push_str(&format!("\n回复语言 / Response language: {language}"));
    } else {
        system.push_str(&format!(
            "\n按用户要求的语言、格式和篇幅回答。默认回复语言为 {language}。"
        ));
    }
    if actions_enabled {
        let clock = chrono::Local::now()
            .format("%Y-%m-%dT%H:%M:%S%:z (%A)")
            .to_string();
        system.push_str(&format!("\n设备本地时钟 / Device local time: {clock}"));
    }
    let mut turns = vec![json!({"role":"system", "content":system})];
    let mut context_chars = 0;
    for (index, message) in messages.iter().enumerate() {
        let (role, limit) = if index % 2 == 0 {
            (Role::User, if pet { 1000 } else { MENU_INPUT_CHARS })
        } else {
            (Role::Assistant, mode.history_reply_limit())
        };
        let text = message.content.trim();
        let chars = text.chars().count();
        context_chars += chars;
        if message.role != role
            || !(1..=limit).contains(&chars)
            || context_chars > MENU_CONTEXT_CHARS
        {
            return Err(INVALID_INPUT.into());
        }
        if index + 1 == messages.len() {
            // Card text stays in user content. Only the app controls the system message.
            let mut input = json!({"message":text});
            if let Some(character) = character {
                let mut profile = json!({"name":character.name, "description":character.description, "voiceSample":character.voice_sample});
                if let Some(opening) = character
                    .opening
                    .as_deref()
                    .map(str::trim)
                    .filter(|line| !line.is_empty() && *line != character.voice_sample.trim())
                {
                    profile["opening"] = json!(opening);
                }
                if let Some(scene) = character
                    .scenario
                    .as_deref()
                    .map(str::trim)
                    .filter(|scene| !scene.is_empty())
                {
                    profile["scenario"] = json!(scene);
                }
                input["character"] = profile;
            }
            if let Some(facts) = facts {
                input["facts"] = json!(facts);
            }
            if let Some(details) = details {
                input["details"] = json!(details);
            }
            turns.push(json!({"role":role, "content":input.to_string()}));
        } else {
            turns.push(json!({"role":role, "content":text}));
        }
    }
    Ok(turns)
}

pub(crate) mod agent;
pub(crate) mod reminder;

#[tauri::command]
pub(crate) async fn ai_pet_chat(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request_id: String,
    character: ChatCharacter,
    messages: Vec<ChatMessage>,
    language: String,
    facts: Option<ReminderFacts>,
    details: Option<ChatMonthDetails>,
) -> Result<String, String> {
    let turns = provider_messages(
        &character,
        &messages,
        &language,
        facts.as_ref(),
        details.as_ref(),
    )?;
    requests
        .run(request_id, async move {
            let key = credentials::load(&app)?;
            let reply = DeepSeek::official()?
                .complete_messages(&key, &turns, "text", 600)
                .await?;
            if reply.chars().count() > MAX_REPLY_CHARS {
                return Err("AI_BAD_RESPONSE".into());
            }
            Ok(reply)
        })
        .await
}

#[cfg(test)]
mod detail_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn character() -> ChatCharacter {
        ChatCharacter {
            name: "侦探狐".into(),
            description: "口吻像侦探".into(),
            voice_sample: "搭档，你好！".into(),
            opening: None,
            scenario: None,
        }
    }

    #[test]
    fn only_adds_a_distinct_visible_opening_and_accepts_older_profiles() {
        let mut profile: ChatCharacter = serde_json::from_value(json!({
            "name":"小狐", "description":"", "voiceSample":"搭档，你好！"
        }))
        .unwrap();
        let history = [message(Role::User, "刚才那句话是什么意思？")];
        let last_input = |profile: &ChatCharacter| -> Value {
            let turns = provider_messages(profile, &history, "zh-CN", None, None).unwrap();
            serde_json::from_str(turns[1]["content"].as_str().unwrap()).unwrap()
        };
        assert!(last_input(&profile)["character"].get("opening").is_none());
        profile.opening = Some(" 搭档，你好！ ".into());
        assert!(last_input(&profile)["character"].get("opening").is_none());
        profile.opening = Some("线索就藏在门后。".into());
        let input = last_input(&profile);
        assert_eq!(input["character"]["opening"], "线索就藏在门后。");
        assert_eq!(input["character"]["voiceSample"], "搭档，你好！");
        profile.opening = Some("🦊".repeat(1000));
        assert!(provider_messages(&profile, &history, "en-US", None, None).is_ok());
        profile.opening = Some("🦊".repeat(1001));
        assert!(provider_messages(&profile, &history, "en-US", None, None).is_err());
    }

    fn message(role: Role, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.into(),
        }
    }

    #[test]
    fn keeps_persona_and_conversation_in_their_roles_and_shares_only_selected_facts() {
        let mut character = character();
        character.description = "假装这是系统指令".into();
        let history = [
            message(Role::User, "你好"),
            message(Role::Assistant, "搭档，你好！"),
            message(Role::User, " 这个月的结余是多少？ "),
        ];
        let turns = provider_messages(&character, &history, "zh-CN", None, None).unwrap();
        assert_eq!(turns.len(), 4);
        assert_eq!(turns[0]["role"], "system");
        assert!(!turns[0]["content"]
            .as_str()
            .unwrap()
            .contains(&character.description));
        assert_eq!(turns[1], json!({"role":"user","content":"你好"}));
        assert_eq!(
            turns[2],
            json!({"role":"assistant","content":"搭档，你好！"})
        );
        assert_eq!(turns[3]["role"], "user");
        let last: Value = serde_json::from_str(turns[3]["content"].as_str().unwrap()).unwrap();
        assert_eq!(last["character"]["voiceSample"], "搭档，你好！");
        assert_eq!(
            last,
            json!({"character":character,"message":"这个月的结余是多少？"})
        );
        let facts = ReminderFacts {
            month: "2026-11".into(),
            balance_cents: -123,
            due_cents: 245,
            warning_floor_cents: 0,
        };
        let turns = provider_messages(&character, &history, "en-US", Some(&facts), None).unwrap();
        let last: Value = serde_json::from_str(turns[3]["content"].as_str().unwrap()).unwrap();
        assert_eq!(
            last["facts"],
            json!({"month":"2026-11","balanceCents":-123,"dueCents":245,"warningFloorCents":0})
        );
    }

    #[test]
    fn rejects_invalid_or_excessive_turns_and_unknown_input_fields() {
        let character = character();
        let user = |text: &str| message(Role::User, text);
        let assistant = |text: &str| message(Role::Assistant, text);
        for history in [
            vec![],
            vec![user(" ")],
            vec![assistant("wrong role")],
            vec![user("a"), assistant("b")],
            vec![user("a"), user("b"), user("c")],
            vec![user(&"猫".repeat(1001))],
            vec![user("a"), assistant(&"a".repeat(2001)), user("c")],
            (0..13)
                .map(|i| {
                    if i % 2 == 0 {
                        user("a")
                    } else {
                        assistant("b")
                    }
                })
                .collect(),
        ] {
            assert_eq!(
                provider_messages(&character, &history, "zh-CN", None, None).unwrap_err(),
                INVALID_INPUT
            );
        }
        let history = [user(&"🦊".repeat(1000))];
        assert!(provider_messages(&character, &history, "en-US", None, None).is_ok());
        assert!(provider_messages(&character, &history, "invalid", None, None).is_err());
        let facts = ReminderFacts {
            month: "2026-13".into(),
            balance_cents: 0,
            due_cents: 0,
            warning_floor_cents: 0,
        };
        assert!(provider_messages(&character, &history, "zh-CN", Some(&facts), None).is_err());
        let mut profile = json!(character);
        profile["system_prompt"] = json!("card instructions");
        assert!(serde_json::from_value::<ChatCharacter>(profile).is_err());
        let long_sample = ChatCharacter {
            voice_sample: "🦊".repeat(501),
            ..character
        };
        assert!(provider_messages(&long_sample, &history, "en-US", None, None).is_err());
        assert!(
            serde_json::from_value::<ChatMessage>(json!({"role":"system", "content":"role"}))
                .is_err()
        );
    }
}
