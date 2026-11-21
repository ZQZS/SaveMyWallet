use super::{credentials, deepseek::DeepSeek, AiRequests, ReminderFacts};
use crate::ledger::{bill_title, check_entry_amount, platform_name};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

const INTERACTION: &str = include_str!("../../../resources/ai/prompts/interaction.md");
const MAX_REPLY_CHARS: usize = 2000;
const INVALID_INPUT: &str = "AI_INVALID_INPUT";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatCharacter {
    name: String,
    description: String,
    voice_sample: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    opening: Option<String>,
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
    if !matches!(language, "zh-CN" | "en-US")
        || character.name.trim().is_empty()
        || character.name.chars().count() > 128
        || character.description.chars().count() > 2000
        || character.voice_sample.chars().count() > 500
        || character
            .opening
            .as_ref()
            .is_some_and(|line| line.chars().count() > 1000)
        || facts.is_some_and(|facts| !facts.is_valid())
        || details.is_some_and(|details| !details.is_valid_for(facts))
        || !(1..=11).contains(&messages.len())
        || messages.len() % 2 == 0
    {
        return Err(INVALID_INPUT.into());
    }

    let system = format!("{INTERACTION}\n回复语言 / Response language: {language}");
    let mut turns = vec![json!({"role":"system", "content":system})];
    for (index, message) in messages.iter().enumerate() {
        let (role, limit) = if index % 2 == 0 {
            (Role::User, 1000)
        } else {
            (Role::Assistant, MAX_REPLY_CHARS)
        };
        let text = message.content.trim();
        if message.role != role || !(1..=limit).contains(&text.chars().count()) {
            return Err(INVALID_INPUT.into());
        }
        if index + 1 == messages.len() {
            // Card text stays in user content. Only the app controls the system message.
            let mut profile = json!({"name":character.name, "description":character.description, "voiceSample":character.voice_sample});
            if let Some(opening) = character
                .opening
                .as_deref()
                .map(str::trim)
                .filter(|line| !line.is_empty() && *line != character.voice_sample.trim())
            {
                profile["opening"] = json!(opening);
            }
            let mut input = json!({"message":text, "character":profile});
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
