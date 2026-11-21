use super::{credentials, AiRequests, ChatCharacter, DeepSeek, INVALID_INPUT};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

const PROMPT: &str = include_str!("../../../../resources/ai/prompts/pet-reminder.md");

#[tauri::command]
pub(crate) async fn ai_pet_reminder_line(
    app: AppHandle,
    requests: State<'_, AiRequests>,
    request_id: String,
    character: ChatCharacter,
    subject: String,
    language: String,
) -> Result<String, String> {
    if !matches!(language.as_str(), "en-US" | "zh-CN")
        || !character.is_valid()
        || subject.chars().count() > 1000
    {
        return Err(INVALID_INPUT.into());
    }
    requests
        .run(request_id, async move {
            let key = credentials::load(&app)?;
            let instruction = format!("{PROMPT}\nResponse language: {language}");
            let input = json!({"character":character, "subject":subject});
            let response = DeepSeek::official_with_timeout(std::time::Duration::from_secs(3))?
                .complete(
                    &key,
                    &instruction,
                    Value::String(input.to_string()),
                    "text",
                    100,
                )
                .await?;
            let line = response.trim();
            if line.is_empty() || line.chars().count() > 100 || line.chars().any(char::is_control) {
                return Err("AI_BAD_RESPONSE".into());
            }
            Ok(line.to_owned())
        })
        .await
}
