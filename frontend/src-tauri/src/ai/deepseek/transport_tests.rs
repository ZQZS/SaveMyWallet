use super::DeepSeek;
use crate::ai::recognize;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    thread::{self, JoinHandle},
    time::Duration,
};

const TEST_KEY: &str = "synthetic-provider-key";

/// One local response, returning the request as received on the socket for protocol assertions.
fn fixture(status: &'static str, response: Value) -> (DeepSeek, JoinHandle<(String, Vec<u8>)>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut input = BufReader::new(&stream);
        let mut headers = String::new();
        while !headers.ends_with("\r\n\r\n") {
            assert!(input.read_line(&mut headers).unwrap() > 0);
        }
        let len: usize = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map_or(0, |(_, value)| value.trim().parse().unwrap());
        let mut body = vec![0; len];
        input.read_exact(&mut body).unwrap();
        let response = response.to_string();
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        (headers, body)
    });
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    (DeepSeek { http, origin }, server)
}

#[test]
fn synthetic_screenshot_reaches_chat_as_inline_image_and_returns_reviewable_drafts() {
    tauri::async_runtime::block_on(async {
        let expected: Value = serde_json::from_str(include_str!(
            "../../../../resources/ai/fixtures/vision-synthetic.json"
        ))
        .unwrap();
        let bytes = include_bytes!("../../../../resources/ai/fixtures/vision-synthetic.png");
        let image = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
        let response = json!({"choices":[{"finish_reason":"stop","message":{"content":expected.to_string()}}]});
        let (provider, server) = fixture("200 OK", response);
        assert_eq!(
            recognize(&provider, TEST_KEY, image.clone(), None)
                .await
                .unwrap(),
            expected
        );
        let (headers, body) = server.join().unwrap();
        assert!(headers.starts_with("POST /chat/completions HTTP/1.1\r\n"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer synthetic-provider-key\r\n"));
        let request: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(request["model"], "deepseek-flash");
        assert_eq!(request["response_format"]["type"], "json_object");
        assert!(!request["messages"][1]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("selectedPlatform"));
        assert_eq!(
            request["messages"][1]["content"][1]["image_url"]["url"],
            image
        );
        assert!(!String::from_utf8(body).unwrap().contains(TEST_KEY));
    });
}

#[test]
fn chosen_platform_is_user_context_and_keeps_recognized_platform_evidence() {
    tauri::async_runtime::block_on(async {
        let chosen = "自定义\"平台\"";
        let drafts = json!({"drafts": [{"platformHint": "截图平台"}, {"platformHint": null}]});
        let response =
            json!({"choices":[{"finish_reason":"stop","message":{"content":drafts.to_string()}}]});
        let (provider, server) = fixture("200 OK", response);
        assert_eq!(
            recognize(&provider, TEST_KEY, "fixture-image".into(), Some(chosen))
                .await
                .unwrap(),
            drafts
        );
        let (_, body) = server.join().unwrap();
        let request: Value = serde_json::from_slice(&body).unwrap();
        let user = &request["messages"][1];
        assert_eq!(user["role"], "user");
        let text = user["content"][0]["text"].as_str().unwrap();
        let (_, context) = text.split_once('\n').unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(context).unwrap(),
            json!({"selectedPlatform": chosen})
        );
    });
}

#[test]
fn key_check_uses_balance_endpoint_and_discards_secrets_in_provider_errors() {
    tauri::async_runtime::block_on(async {
        let responses = [
            (
                "200 OK",
                json!({"is_available":true,"balance_infos":[]}),
                Ok(()),
            ),
            ("200 OK", json!({"is_available":false}), Err("AI_BALANCE")),
            (
                "401 Unauthorized",
                json!({"error":format!("invalid authorization: {TEST_KEY}")}),
                Err("AI_AUTH"),
            ),
            (
                "500 Internal Server Error",
                json!({"debug":"private input sample"}),
                Err("AI_PROVIDER"),
            ),
        ];
        for (status, reply, expected) in responses {
            let (provider, server) = fixture(status, reply);
            assert_eq!(
                provider.test_key(TEST_KEY).await,
                expected.map_err(str::to_owned)
            );
            let (headers, body) = server.join().unwrap();
            assert!(headers.starts_with("GET /user/balance HTTP/1.1\r\n"));
            assert!(headers
                .to_ascii_lowercase()
                .contains("authorization: bearer synthetic-provider-key\r\n"));
            assert!(body.is_empty());
        }
    });
}
