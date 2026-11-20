//! The two WebViews share this transport. SQLite locks are released before every network await.
use crate::{ledger::sync, Database};
use reqwest::{Client, RequestBuilder, StatusCode, Url};
use serde_json::{json, Value};
use std::{net::IpAddr, sync::Mutex, time::Duration};
use tauri::State;

type Reply = Result<Value, String>;

#[cfg(test)]
mod live_tests;

#[test]
fn server_addresses_allow_https_and_local_development_paths() {
    for input in [
        "http://192.168.1.2",
        "file:///tmp/ledger",
        "https://user:pass@wallet.test",
        "https://wallet.test/?token=abc",
        "https://wallet.test/#private",
    ] {
        assert!(service_url(input).is_err());
    }
    for input in [
        "http://127.0.0.1:5180",
        "http://[::1]:5180",
        "https://wallet.test/ledger",
    ] {
        assert_eq!(service_url(&format!("{input}/")).unwrap(), input);
    }
}

#[derive(Default)]
pub(super) struct SyncClient {
    cycle: tokio::sync::Mutex<()>,
    token: Mutex<Option<Access>>,
    preview: Mutex<Option<Preview>>,
}

struct Preview {
    url: String,
    ledger_id: String,
    cursor: u64,
    local_changes: (u64, i64),
}

// Another desktop process can relink the same SQLite file while this process is running.
// A bearer credential belongs only to the service and ledger that authenticated it.
struct Access {
    url: String,
    ledger: String,
    token: String,
}

impl Access {
    fn matches(&self, url: &str, ledger: &str) -> bool {
        self.url == url && self.ledger == ledger
    }
}

fn service_url(input: &str) -> Result<String, String> {
    let url = Url::parse(input.trim()).map_err(|_| "SYNC_URL")?;
    let host = url.host_str().ok_or("SYNC_URL")?;
    let loopback = host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("SYNC_URL".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn validate_token(token: &str) -> Result<(), String> {
    if !(32..=1024).contains(&token.len()) || !token.bytes().all(|c| c.is_ascii_graphic()) {
        return Err("SYNC_TOKEN".into());
    }
    Ok(())
}

fn transport() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(40))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "SYNC_NETWORK".into())
}

async fn exchange(
    request: RequestBuilder,
    token: &str,
    ledger: Option<&str>,
) -> Result<(StatusCode, Value), String> {
    let mut request = request.bearer_auth(token);
    if let Some(id) = ledger {
        request = request.header("X-Ledger-Id", id);
    }
    let mut response = request.send().await.map_err(|_| "SYNC_NETWORK")?;
    let status = response.status();
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return Err("SYNC_AUTH".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "SYNC_NETWORK")? {
        if bytes.len() + chunk.len() > 64 * 1024 * 1024 {
            return Err("SYNC_PROTOCOL".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        if status.is_success() {
            "SYNC_PROTOCOL"
        } else {
            "SYNC_SERVER"
        }
    })?;
    if status.is_success() {
        return Ok((status, value));
    }
    match value["code"].as_str() {
        Some("conflict") if status == StatusCode::CONFLICT => Ok((status, value)),
        Some("ledger_mismatch") => Err("SYNC_LEDGER_MISMATCH".into()),
        Some("seed_exists") => Err("SYNC_SEED_EXISTS".into()),
        Some(code)
            if code.len() <= 64 && code.bytes().all(|c| c.is_ascii_lowercase() || c == b'_') =>
        {
            Err(format!("SYNC_SERVER:{code}"))
        }
        _ => Err("SYNC_SERVER".into()),
    }
}

async fn bootstrap(client: &Client, url: &str, token: &str, ledger: Option<&str>) -> Reply {
    let (status, page) =
        exchange(client.get(format!("{url}/sync/bootstrap")), token, ledger).await?;
    if !status.is_success()
        || page["cursor"].as_u64().is_none()
        || !page["records"].is_array()
        || page["ledgerId"].as_str().is_none_or(str::is_empty)
    {
        return Err("SYNC_PROTOCOL".into());
    }
    if ledger.is_some_and(|id| Some(id) != page["ledgerId"].as_str()) {
        return Err("SYNC_LEDGER_MISMATCH".into());
    }
    Ok(page)
}

impl SyncClient {
    fn set_token(&self, token: Option<Access>) -> Result<(), String> {
        *self.token.lock().map_err(|_| "SYNC_INTERNAL")? = token;
        Ok(())
    }

    fn status(&self, db: &Database) -> Reply {
        let mut result = db.access(|conn| sync::status(conn))?;
        let authenticated = self
            .token
            .lock()
            .map_err(|_| "SYNC_INTERNAL")?
            .as_ref()
            .is_some_and(|access| {
                result["url"].as_str() == Some(access.url.as_str())
                    && result["ledgerId"].as_str() == Some(access.ledger.as_str())
            });
        result["authenticated"] = json!(authenticated);
        Ok(result)
    }

    async fn preview(&self, db: &Database, url: &str, token: &str) -> Reply {
        let _guard = self.cycle.lock().await;
        let url = service_url(url)?;
        validate_token(token)?;
        let page = bootstrap(&transport()?, &url, token, None).await?;
        let records = page["records"].as_array().ok_or("SYNC_PROTOCOL")?;
        let count = |kind: &str| {
            records
                .iter()
                .filter(|r| r["kind"] == kind && !r["value"].is_null())
                .count()
        };
        let local_changes = db.access(|conn| {
            if sync::status(conn)?["bound"] == true {
                return Err("SYNC_BOUND".into());
            }
            sync::data_stamp(conn)
        })?;
        *self.preview.lock().map_err(|_| "SYNC_INTERNAL")? = Some(Preview {
            url,
            ledger_id: page["ledgerId"]
                .as_str()
                .ok_or("SYNC_PROTOCOL")?
                .to_string(),
            cursor: page["cursor"].as_u64().ok_or("SYNC_PROTOCOL")?,
            local_changes,
        });
        Ok(
            json!({"ledgerId":page["ledgerId"],"cursor":page["cursor"],"platforms":count("platform"),
            "entries":count("entry"),"empty":page["cursor"] == 0 && records.is_empty()}),
        )
    }

    async fn bind(
        &self,
        db: &Database,
        url: &str,
        token: String,
        ledger_id: String,
        cursor: u64,
    ) -> Reply {
        let _guard = self.cycle.lock().await;
        let url = service_url(url)?;
        validate_token(&token)?;
        let page = bootstrap(&transport()?, &url, &token, Some(&ledger_id)).await?;
        if page["cursor"].as_u64() != Some(cursor) {
            return Err("SYNC_PREVIEW_STALE".into());
        }
        let preview = self
            .preview
            .lock()
            .map_err(|_| "SYNC_INTERNAL")?
            .take()
            .ok_or("SYNC_PREVIEW_STALE")?;
        if preview.url != url || preview.ledger_id != ledger_id || preview.cursor != cursor {
            return Err("SYNC_PREVIEW_STALE".into());
        }
        let empty = cursor == 0 && page["records"].as_array().is_some_and(Vec::is_empty);
        db.access(|conn| {
            sync::bind_checked(
                conn,
                &url,
                &page,
                if empty { "publish" } else { "replace" },
                preview.local_changes,
            )
        })?;
        self.set_token(Some(Access {
            url,
            ledger: ledger_id,
            token,
        }))?;
        self.status(db)
    }

    fn binding(&self, db: &Database) -> Result<(String, String, u64), String> {
        let state = self.status(db)?;
        Ok((
            state["url"].as_str().ok_or("SYNC_NOT_BOUND")?.to_owned(),
            state["ledgerId"]
                .as_str()
                .ok_or("SYNC_NOT_BOUND")?
                .to_owned(),
            state["cursor"].as_u64().ok_or("SYNC_PROTOCOL")?,
        ))
    }

    async fn run(&self, db: &Database) -> Reply {
        let _guard = self.cycle.lock().await;
        let (url, ledger, cursor) = self.binding(db)?;
        let token = self
            .token
            .lock()
            .map_err(|_| "SYNC_INTERNAL")?
            .as_ref()
            .filter(|access| access.matches(&url, &ledger))
            .map(|access| access.token.clone())
            .ok_or("SYNC_AUTH")?;
        let result = self.transfer(db, &url, &token, &ledger, cursor).await;
        if matches!(
            result.as_ref().err().map(String::as_str),
            Some("SYNC_AUTH" | "SYNC_LEDGER_MISMATCH")
        ) {
            self.set_token(None)?;
        }
        result?;
        self.status(db)
    }

    async fn transfer(
        &self,
        db: &Database,
        url: &str,
        token: &str,
        ledger: &str,
        mut cursor: u64,
    ) -> Result<(), String> {
        let client = transport()?;
        // Bound each cycle so incoming local writes cannot indefinitely postpone a pull.
        for _ in 0..128 {
            let Some(op) = db.access(|conn| sync::next_for(conn, url, ledger))? else {
                break;
            };
            let op_id = op["operationId"].as_str().ok_or("SYNC_PROTOCOL")?;
            let (status, result) = exchange(
                client.post(format!("{url}/sync/push")).json(&op),
                token,
                Some(ledger),
            )
            .await?;
            if status == StatusCode::CONFLICT {
                db.access(|conn| sync::conflict(conn, op_id, &result))?;
            } else {
                if result["operationId"] != op["operationId"] {
                    return Err("SYNC_PROTOCOL".into());
                }
                db.access(|conn| sync::ack(conn, &result))?;
            }
        }
        for _ in 0..128 {
            let (status, page) = exchange(
                client.get(format!("{url}/sync/pull?cursor={cursor}")),
                token,
                Some(ledger),
            )
            .await?;
            if !status.is_success() || page["ledgerId"].as_str() != Some(ledger) {
                return Err("SYNC_LEDGER_MISMATCH".into());
            }
            let next = page["cursor"].as_u64().ok_or("SYNC_PROTOCOL")?;
            let more = page["hasMore"].as_bool().ok_or("SYNC_PROTOCOL")?;
            if next < cursor || more && next == cursor {
                return Err("SYNC_PROTOCOL".into());
            }
            db.access(|conn| sync::pull_for(conn, url, ledger, &page))?;
            if !more {
                break;
            }
            cursor = next;
        }
        Ok(())
    }
}

#[tauri::command(async)]
pub(super) fn sync_status(db: State<'_, Database>, client: State<'_, SyncClient>) -> Reply {
    client.status(&db)
}

#[tauri::command]
pub(super) async fn sync_preview(
    db: State<'_, Database>,
    client: State<'_, SyncClient>,
    url: String,
    token: String,
) -> Reply {
    client.preview(&db, &url, &token).await
}

#[tauri::command]
pub(super) async fn sync_bind(
    db: State<'_, Database>,
    client: State<'_, SyncClient>,
    url: String,
    token: String,
    ledger_id: String,
    cursor: u64,
) -> Reply {
    client.bind(&db, &url, token, ledger_id, cursor).await
}

#[tauri::command]
pub(super) async fn sync_authenticate(
    db: State<'_, Database>,
    client: State<'_, SyncClient>,
    token: String,
) -> Reply {
    let _guard = client.cycle.lock().await;
    let (url, ledger, _) = client.binding(&db)?;
    validate_token(&token)?;
    client.set_token(None)?;
    bootstrap(&transport()?, &url, &token, Some(&ledger)).await?;
    client.set_token(Some(Access { url, ledger, token }))?;
    client.status(&db)
}

#[tauri::command]
pub(super) async fn sync_run(db: State<'_, Database>, client: State<'_, SyncClient>) -> Reply {
    client.run(&db).await
}

#[tauri::command]
pub(super) async fn sync_resolve(
    db: State<'_, Database>,
    client: State<'_, SyncClient>,
    operation_id: String,
    choice: String,
) -> Reply {
    let _guard = client.cycle.lock().await;
    let choice = match choice.as_str() {
        "local" => "local",
        "server" => "remote",
        _ => return Err("SYNC_PROTOCOL".into()),
    };
    db.access(|conn| sync::resolve(conn, &operation_id, choice))?;
    client.status(&db)
}

#[tauri::command]
pub(super) async fn sync_disconnect(
    db: State<'_, Database>,
    client: State<'_, SyncClient>,
) -> Reply {
    let _guard = client.cycle.lock().await;
    db.access(sync::unbind)?;
    client.set_token(None)?;
    client.status(&db)
}

#[tauri::command(async)]
pub(super) fn sync_previous_backup(db: State<'_, Database>) -> Result<Option<String>, String> {
    db.access(|conn| sync::previous_backup(conn))
}
