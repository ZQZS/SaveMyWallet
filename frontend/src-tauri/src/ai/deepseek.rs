use reqwest::{Client, RequestBuilder, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 256 * 1024;

pub(super) struct DeepSeek {
    http: Client,
    origin: String,
}

fn check_status(status: StatusCode) -> Result<(), String> {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err("AI_AUTH".into()),
        StatusCode::PAYMENT_REQUIRED => Err("AI_BALANCE".into()),
        StatusCode::TOO_MANY_REQUESTS => Err("AI_RATE_LIMIT".into()),
        status if status.is_success() => Ok(()),
        _ => Err("AI_PROVIDER".into()),
    }
}

async fn response_json(request: RequestBuilder) -> Result<Value, String> {
    let mut response = request.send().await.map_err(|_| "AI_NETWORK")?;
    // Provider error bodies may echo the message or screenshot. Only return a stable error code.
    check_status(response.status())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "AI_NETWORK")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("AI_BAD_RESPONSE".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "AI_BAD_RESPONSE".into())
}

fn completion_content(reply: &Value) -> Result<&str, String> {
    let choice = &reply["choices"][0];
    if choice["finish_reason"] != "stop" {
        return Err("AI_BAD_RESPONSE".into());
    }
    choice["message"]["content"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "AI_BAD_RESPONSE".into())
}

impl DeepSeek {
    pub(super) fn official() -> Result<Self, String> {
        Self::official_with_timeout(Duration::from_secs(60))
    }

    pub(super) fn official_with_timeout(timeout: Duration) -> Result<Self, String> {
        let http = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(timeout)
            .build()
            .map_err(|_| "AI_NETWORK")?;
        Ok(Self {
            http,
            origin: "https://api.deepseek.com".into(),
        })
    }

    pub(super) async fn test_key(&self, key: &str) -> Result<(), String> {
        let reply = response_json(
            self.http
                .get(format!("{}/user/balance", self.origin))
                .timeout(Duration::from_secs(12))
                .bearer_auth(key),
        )
        .await?;
        match reply["is_available"].as_bool() {
            Some(true) => Ok(()),
            Some(false) => Err("AI_BALANCE".into()),
            None => Err("AI_BAD_RESPONSE".into()),
        }
    }

    pub(super) async fn complete(
        &self,
        key: &str,
        instruction: &str,
        input: Value,
        format: &str,
        max_tokens: u32,
    ) -> Result<String, String> {
        let mut messages = [
            json!({"role": "system", "content": instruction}),
            json!({"role": "user"}),
        ];
        messages[1]["content"] = input;
        self.complete_messages(key, &messages, format, max_tokens)
            .await
    }

    pub(super) async fn complete_messages(
        &self,
        key: &str,
        messages: &[Value],
        format: &str,
        max_tokens: u32,
    ) -> Result<String, String> {
        // Serialize image data directly from the message blocks; long bills can contain many MiB.
        #[derive(Serialize)]
        struct CompletionBody<'a> {
            model: &'static str,
            thinking: Value,
            response_format: Value,
            max_tokens: u32,
            messages: &'a [Value],
        }
        let body = CompletionBody {
            model: "deepseek-flash",
            thinking: json!({"type": "disabled"}),
            response_format: json!({"type": format}),
            max_tokens,
            messages,
        };
        let request = self.http.post(format!("{}/chat/completions", self.origin));
        let result = response_json(request.bearer_auth(key).json(&body)).await?;
        Ok(completion_content(&result)?.to_owned())
    }
}

#[cfg(test)]
mod transport_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_only_complete_nonempty_final_content() {
        let mut reply = json!({"choices":[{"finish_reason":"stop","message":{
            "content":"  {}\n", "reasoning_content":"private"
        }}]});
        assert_eq!(completion_content(&reply).unwrap(), "{}");
        reply["choices"][0]["finish_reason"] = json!("length");
        assert_eq!(completion_content(&reply).unwrap_err(), "AI_BAD_RESPONSE");
        reply["choices"][0]["finish_reason"] = json!("stop");
        reply["choices"][0]["message"]["content"] = json!("   ");
        assert_eq!(completion_content(&reply).unwrap_err(), "AI_BAD_RESPONSE");
    }

    #[test]
    fn provider_statuses_map_to_local_error_codes() {
        assert_eq!(
            check_status(StatusCode::UNAUTHORIZED).unwrap_err(),
            "AI_AUTH"
        );
        assert_eq!(
            check_status(StatusCode::PAYMENT_REQUIRED).unwrap_err(),
            "AI_BALANCE"
        );
        assert_eq!(
            check_status(StatusCode::TOO_MANY_REQUESTS).unwrap_err(),
            "AI_RATE_LIMIT"
        );
        assert_eq!(
            check_status(StatusCode::TEMPORARY_REDIRECT).unwrap_err(),
            "AI_PROVIDER"
        );
    }
}
