use super::{bootstrap, exchange, transport, SyncClient};
use crate::{ledger, Database};
use serde_json::{json, Value};
use std::{env, path::PathBuf, sync::Mutex};

fn database(directory: PathBuf) -> Database {
    Database {
        directory,
        connection: Mutex::new(None),
    }
}

fn snapshot(db: &Database) -> Value {
    serde_json::to_value(db.access(ledger::snapshot).unwrap()).unwrap()
}

#[test]
fn an_unlocked_token_cannot_follow_a_different_server_binding() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path().into());
    let client = SyncClient::default();
    let page = json!({"ledgerId":"personal","cursor":0,"records":[]});
    let service = "https://first.invalid";
    db.access(|conn| ledger::sync::bind(conn, service, &page, "publish"))
        .unwrap();
    client
        .set_token(Some(super::Access {
            url: service.into(),
            ledger: "personal".into(),
            token: "test-only".into(),
        }))
        .unwrap();
    assert_eq!(client.status(&db).unwrap()["authenticated"], true);
    db.access(ledger::sync::unbind).unwrap();
    db.access(|conn| ledger::sync::bind(conn, "https://second.invalid", &page, "publish"))
        .unwrap();
    assert_eq!(client.status(&db).unwrap()["authenticated"], false);
    let result = tauri::async_runtime::block_on(client.run(&db));
    assert_eq!(result.unwrap_err(), "SYNC_AUTH");
}

async fn bind_device(
    client: &SyncClient,
    db: &Database,
    url: &str,
    token: &str,
    empty: bool,
) -> String {
    let preview = client.preview(db, url, token).await.unwrap();
    assert_eq!(
        preview["empty"], empty,
        "The integration test needs its own initially empty PostgreSQL ledger."
    );
    let ledger_id = preview["ledgerId"].as_str().unwrap().to_owned();
    client
        .bind(
            db,
            url,
            token.to_owned(),
            ledger_id.clone(),
            preview["cursor"].as_u64().unwrap(),
        )
        .await
        .unwrap();
    ledger_id
}

fn create_bill(db: &Database, platform: &str, kind: &str, count: usize, title: &str) {
    let input = serde_json::from_value(json!({"title": title, "platformId":platform, "kind":kind,
        "month":"2026-12", "amountCents":30000, "installmentCount":count}))
    .unwrap();
    db.access(|conn| ledger::add_bill(conn, input)).unwrap();
}

fn confirm(db: &Database, id: &str, title: &str, month: &str, cents: i64) {
    let input =
        serde_json::from_value(json!({"id":id, "title":title, "month":month, "amountCents":cents}))
            .unwrap();
    db.access(|conn| ledger::confirm(conn, input)).unwrap();
}

// Requires an isolated live API and an unused test ledger. Creates only synthetic data.
#[test]
#[ignore = "set SMW_TEST_URL and SMW_TEST_TOKEN for a disposable PostgreSQL-backed API"]
fn two_native_sqlite_replicas_sync_through_the_live_postgres_api() {
    tauri::async_runtime::block_on(async {
        let base = env::var("SMW_TEST_URL").expect("set SMW_TEST_URL");
        let url = base.trim_end_matches('/');
        let token = env::var("SMW_TEST_TOKEN").expect("set SMW_TEST_TOKEN");
        let files = tempfile::tempdir().unwrap();
        let windows = database(files.path().join("windows"));
        let android = database(files.path().join("android"));
        let windows_client = SyncClient::default();
        let android_client = SyncClient::default();

        let ledger_id = bind_device(&windows_client, &windows, url, &token, true).await;
        windows_client.run(&windows).await.unwrap();
        bind_device(&android_client, &android, url, &token, false).await;
        let platform = snapshot(&windows)["platforms"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        create_bill(&windows, &platform, "installment", 12, "分期重试");
        let operation = windows
            .access(|conn| ledger::sync::next(conn))
            .unwrap()
            .unwrap();
        let http = transport().unwrap();
        let post = || http.post(format!("{url}/sync/push")).json(&operation);
        // The server has accepted all periods, but the client never receives/persists its receipt.
        let (code, _) = exchange(post(), &token, Some(&ledger_id)).await.unwrap();
        assert!(code.is_success());
        drop(windows);
        let windows = database(files.path().join("windows"));
        windows_client.run(&windows).await.unwrap(); // retransmits the persisted operationId
        android_client.run(&android).await.unwrap();
        assert_eq!(snapshot(&android)["entries"].as_array().unwrap().len(), 12);
        let canonical = bootstrap(&http, url, &token, Some(&ledger_id))
            .await
            .unwrap();
        assert_eq!(
            canonical["records"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|r| r["kind"] == "entry")
                .count(),
            12
        );
        assert_eq!(snapshot(&windows)["entries"], snapshot(&android)["entries"]);

        let periods = snapshot(&windows)["entries"].clone();
        let first_id = periods[0]["id"].as_str().unwrap();
        windows
            .access(|conn| ledger::set_entry_voided(conn, first_id, true))
            .unwrap();
        windows_client.run(&windows).await.unwrap();
        android_client.run(&android).await.unwrap();
        let mut expected = periods.clone();
        expected[0]["voided"] = json!(true);
        assert_eq!(snapshot(&android)["entries"], expected);
        android
            .access(|conn| ledger::set_entry_voided(conn, first_id, false))
            .unwrap();
        android_client.run(&android).await.unwrap();
        windows_client.run(&windows).await.unwrap();
        assert_eq!(snapshot(&windows)["entries"], periods);

        // An identical purchase has different period IDs and belongs to a separate series.
        create_bill(&android, &platform, "installment", 12, "分期重试");
        android_client.run(&android).await.unwrap();
        windows_client.run(&windows).await.unwrap();
        let all_periods = snapshot(&android)["entries"].clone();
        let selected = &periods[6];
        let group = selected["installmentId"].as_str().unwrap();
        let id = selected["id"].as_str().unwrap();
        let mut voided = all_periods.clone();
        let all_rows = voided.as_array_mut().unwrap();
        assert_eq!(all_rows.len(), 24);
        let matching: Vec<_> = all_rows
            .iter_mut()
            .filter(|entry| entry["installmentId"] == group)
            .collect();
        assert_eq!(matching.len(), 12);
        for entry in matching {
            entry["voided"] = json!(true);
        }
        windows
            .access(|conn| ledger::set_installment_voided(conn, id, true))
            .unwrap();
        windows_client.run(&windows).await.unwrap();
        android_client.run(&android).await.unwrap();
        assert_eq!(snapshot(&android)["entries"], voided);
        android
            .access(|conn| ledger::set_installment_voided(conn, first_id, false))
            .unwrap();
        android_client.run(&android).await.unwrap();
        windows_client.run(&windows).await.unwrap();
        assert_eq!(snapshot(&windows)["entries"], all_periods);

        for (title, choice, expected_month, expected_amount) in [
            ("选择本机", "local", "2027-01", 35000),
            ("选择服务器", "remote", "2026-12", 32000),
        ] {
            create_bill(&windows, &platform, "estimate", 1, title);
            windows_client.run(&windows).await.unwrap();
            android_client.run(&android).await.unwrap();
            let ledger = snapshot(&windows);
            let id = ledger["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["title"] == title)
                .unwrap()["id"]
                .as_str()
                .unwrap();
            // Both clients edit the same entry without contacting the API.
            confirm(&windows, id, title, "2026-12", 32000);
            confirm(&android, id, title, "2027-01", 35000);
            windows_client.run(&windows).await.unwrap();
            let blocked = android_client.run(&android).await.unwrap();
            let conflicts = blocked["conflicts"].as_array().unwrap();
            assert_eq!(conflicts.len(), 1);
            let operation_id = conflicts[0]["operationId"].as_str().unwrap();
            android
                .access(|conn| ledger::sync::resolve(conn, operation_id, choice))
                .unwrap();
            let state = android_client.run(&android).await.unwrap();
            assert!(state["conflicts"].as_array().unwrap().is_empty());
            windows_client.run(&windows).await.unwrap();
            for device in [&windows, &android] {
                let local = snapshot(device);
                let copies: Vec<_> = local["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|entry| entry["id"] == id)
                    .collect();
                assert_eq!(copies.len(), 1);
                assert_eq!(copies[0]["month"], expected_month);
                assert_eq!(copies[0]["amountCents"], expected_amount);
            }
            let canonical = bootstrap(&http, url, &token, Some(&ledger_id))
                .await
                .unwrap();
            let record = canonical["records"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["kind"] == "entry" && r["id"] == id)
                .unwrap();
            assert_eq!(record["value"]["month"], expected_month);
            assert_eq!(record["value"]["amountCents"], expected_amount);
        }
    });
}
