use super::{ack, bind, conflict, next, pull, resolve, status, unbind};
use crate::ledger::{self, backup, BillInput, ConfirmInput};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;

mod publish_undo;

const URL: &str = "https://sync.example.invalid";
const LEDGER: &str = "test-ledger";

#[test]
fn another_process_cannot_replace_a_changed_preview_or_send_the_rebound_ledgers_data() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("shared.sqlite3");
    let mut first = Connection::open(&file).unwrap();
    let mut second = Connection::open(&file).unwrap();
    ledger::migrate(&mut first).unwrap();
    ledger::migrate(&mut second).unwrap();
    let preview = super::data_stamp(&first).unwrap();
    let fresh_id = ledger::add_platform(&second, "录入于预览之后").unwrap();
    let incoming = json!([{"kind":"platform","id":"old","version":"old-event",
        "value":{"id":"old","name":"旧服务的平台"}}]);
    let remote = page(1, &incoming);
    assert_eq!(
        super::bind_checked(&mut first, URL, &remote, "replace", preview)
            .unwrap_err()
            .to_string(),
        "SYNC_PREVIEW_STALE"
    );
    assert!(ledger::snapshot(&mut first)
        .unwrap()
        .platforms
        .iter()
        .any(|p| p.id == fresh_id));

    let empty = page(0, &json!([]));
    bind(&mut first, URL, &empty, "publish").unwrap();
    let old_op = super::next_for(&first, URL, LEDGER).unwrap().unwrap();
    unbind(&mut second).unwrap();
    let other_url = "https://second.example.invalid";
    // Independent services may use the same ledger identifier.
    bind(&mut second, other_url, &empty, "publish").unwrap();
    assert_eq!(
        super::next_for(&first, URL, LEDGER)
            .unwrap_err()
            .to_string(),
        "SYNC_LEDGER_MISMATCH"
    );
    assert_eq!(
        super::next_for(&first, other_url, "some-other-ledger")
            .unwrap_err()
            .to_string(),
        "SYNC_LEDGER_MISMATCH"
    );
    assert_eq!(
        super::pull_for(&mut first, URL, LEDGER, &remote)
            .unwrap_err()
            .to_string(),
        "SYNC_LEDGER_MISMATCH"
    );
    let current = super::next_for(&first, other_url, LEDGER).unwrap().unwrap();
    assert_ne!(old_op["operationId"], current["operationId"]);
    let old_receipt = accepted(&old_op, 1);
    ack(&mut first, &old_receipt).unwrap();
    assert!(conflict(
        &mut first,
        old_op["operationId"].as_str().unwrap(),
        &json!({"code":"conflict","cursor":1,"records":old_receipt["records"]})
    )
    .is_err());
    assert_eq!(
        super::next_for(&second, other_url, LEDGER).unwrap(),
        Some(current)
    );
    assert_eq!(status(&second).unwrap()["cursor"], 0);
    assert!(ledger::snapshot(&mut second)
        .unwrap()
        .platforms
        .iter()
        .all(|p| p.id != "old"));
}

fn database() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    ledger::migrate(&mut connection).unwrap();
    connection
}

fn page(cursor: i64, records: &Value) -> Value {
    json!({"ledgerId": LEDGER, "cursor": cursor, "records": records, "hasMore": false})
}

#[test]
fn a_daily_restore_keeps_the_pre_bind_ledger_and_invalidates_old_writers() {
    use crate::ledger::{history, review};
    use chrono::Local;

    let mut local = database();
    let yesterday = Local::now().date_naive().pred_opt().unwrap();
    let tx = local.transaction().unwrap();
    history::checkpoint_on(&tx, yesterday).unwrap();
    tx.commit().unwrap();
    let original = backup::export(&mut local).unwrap();

    let mut other = database();
    ledger::add_platform(&other, "远端专属平台").unwrap();
    let remote_page = publish(&mut other);
    bind(&mut local, URL, &remote_page, "replace").unwrap();
    ledger::add_platform(&local, "尚未上传").unwrap();
    let queued = next(&local).unwrap().unwrap();
    let bound_state = status(&local).unwrap();
    assert_eq!(bound_state["pending"], 1);
    let preview = |db: &mut Connection| {
        history::list(db)
            .unwrap()
            .into_iter()
            .find(|point| point.days_ago == 1)
            .unwrap()
    };
    let point = preview(&mut local);
    let restore = |db: &mut Connection, point: &history::RestorePoint| {
        history::restore(db, point.days_ago, &point.date, &point.revision)
    };
    assert_eq!(
        restore(&mut local, &point).unwrap_err().to_string(),
        "SYNC_BOUND"
    );
    assert_eq!(status(&local).unwrap(), bound_state);
    assert_eq!(next(&local).unwrap(), Some(queued.clone()));

    unbind(&mut local).unwrap();
    let point = preview(&mut local);
    let before_restore = super::data_stamp(&local).unwrap();
    let reviewed = serde_json::to_value(review::snapshot(&mut local).unwrap()).unwrap();
    restore(&mut local, &point).unwrap();
    let revision = reviewed["revision"].as_str().unwrap();
    assert_eq!(
        ledger::add_platform(review::LedgerWrite::new(&local, Some(revision)), "过期请求")
            .unwrap_err()
            .to_string(),
        "AI_ACTION_STALE"
    );
    assert_eq!(
        super::bind_checked(&mut local, URL, &remote_page, "replace", before_restore)
            .unwrap_err()
            .to_string(),
        "SYNC_PREVIEW_STALE"
    );
    assert_eq!(
        super::pull_for(&mut local, URL, LEDGER, &remote_page)
            .unwrap_err()
            .to_string(),
        "SYNC_NOT_BOUND"
    );
    assert!(ack(&mut local, &accepted(&queued, 2)).is_err());

    let unbound_state = status(&local).unwrap();
    assert_eq!(unbound_state["bound"], false);
    assert_eq!(unbound_state["pending"], 0);
    assert_eq!(backup::export(&mut local).unwrap(), original);
    assert_eq!(next(&other).unwrap(), None);
    assert!(ledger::snapshot(&mut other)
        .unwrap()
        .platforms
        .iter()
        .any(|p| p.name == "远端专属平台"));
}

#[test]
fn first_remote_pull_of_the_day_preserves_the_previous_local_state() {
    use crate::ledger::history;
    use chrono::Local;

    let mut local = database();
    bind(&mut local, URL, &page(0, &json!([])), "publish").unwrap();
    let tx = local.transaction().unwrap();
    history::checkpoint_on(&tx, Local::now().date_naive().pred_opt().unwrap()).unwrap();
    tx.commit().unwrap();
    let before = backup::export(&mut local).unwrap();
    let incoming = json!([{"kind":"platform","id":"after-midnight","version":"v2",
        "value":{"id":"after-midnight","name":"今天从远端拉取"}}]);
    pull(&mut local, &page(2, &incoming)).unwrap();
    assert_ne!(backup::export(&mut local).unwrap(), before);
    unbind(&mut local).unwrap();
    let point = history::list(&mut local)
        .unwrap()
        .into_iter()
        .find(|p| p.days_ago == 1)
        .unwrap();
    history::restore(&mut local, 1, &point.date, &point.revision).unwrap();
    assert_eq!(backup::export(&mut local).unwrap(), before);
}

// Turn a successfully applied operation into the wire receipt a server returns.
fn accepted(operation: &Value, cursor: i64) -> Value {
    let changes = operation["changes"].as_array().unwrap();
    let records: Vec<_> = changes
        .iter()
        .map(|change| {
            json!({
                "kind": change["kind"], "id": change["id"],
                "value": change["after"], "version": operation["operationId"]
            })
        })
        .collect();
    let ids: Vec<_> = changes.iter().map(|change| &change["id"]).collect();
    json!({"operationId": operation["operationId"], "cursor": cursor, "records": records, "changedIds": ids})
}

fn publish(db: &mut Connection) -> Value {
    bind(db, URL, &page(0, &json!([])), "publish").unwrap();
    let seed = next(db)
        .unwrap()
        .expect("local ledger has initial platforms");
    let receipt = accepted(&seed, 1);
    ack(db, &receipt).unwrap();
    let published = page(1, &receipt["records"]);
    pull(db, &published).unwrap();
    published
}

fn bill(platform_id: &str, kind: &str, count: u32) -> BillInput {
    BillInput {
        platform_id: platform_id.into(),
        title: "画册".into(),
        month: "2026-12".into(),
        amount_cents: 30000,
        total_cents: None,
        deposit_cents: None,
        kind: kind.into(),
        installment_count: count,
        installment_index: None,
    }
}

fn ai_preview(db: &mut Connection) -> Value {
    serde_json::to_value(ledger::ai_undo::preview(db).unwrap()).unwrap()
}

#[test]
fn queued_ai_writes_can_be_withdrawn_without_touching_manual_work_or_a_frozen_request() {
    let mut db = database();
    publish(&mut db); // A legacy server can still withdraw a request it has never seen.
    let revision = ledger::review::revision(&db).unwrap();
    let id = ledger::add_platform(
        ledger::review::LedgerWrite::new(&db, Some(&revision)),
        "AI 平台",
    )
    .unwrap();
    let token = ai_preview(&mut db)["token"].as_str().unwrap().to_owned();
    let hand = ledger::add_platform(&db, "手动平台").unwrap();
    ledger::ai_undo::apply(&mut db, &token).unwrap();
    let manual = next(&db).unwrap().unwrap();
    assert_eq!(manual["changes"][0]["id"], hand);
    let ids = ledger::snapshot(&mut db)
        .unwrap()
        .platforms
        .into_iter()
        .map(|p| p.id)
        .collect::<Vec<_>>();
    assert!(ids.contains(&hand) && !ids.contains(&id));
    ack(&mut db, &accepted(&manual, 2)).unwrap();
    let revision = ledger::review::revision(&db).unwrap();
    ledger::add_platform(
        ledger::review::LedgerWrite::new(&db, Some(&revision)),
        "等回执",
    )
    .unwrap();
    let frozen = next(&db).unwrap().unwrap();
    assert_eq!(ai_preview(&mut db)["blockedReason"], "AI_UNDO_SYNC_PENDING");
    assert_eq!(next(&db).unwrap().unwrap(), frozen);
    ack(&mut db, &accepted(&frozen, 3)).unwrap();
    assert_eq!(ai_preview(&mut db)["blockedReason"], "AI_UNDO_SYNC_UPGRADE");
    let mut upgraded = page(3, &json!([]));
    upgraded["supportsAiRevert"] = json!(true);
    pull(&mut db, &upgraded).unwrap();
    let ticket = ai_preview(&mut db);
    assert_eq!(ticket["blocked"], false);
    ledger::ai_undo::apply(&mut db, ticket["token"].as_str().unwrap()).unwrap();
    let revert = next(&db).unwrap().unwrap();
    assert_eq!(revert["revertOperationIds"], json!([frozen["operationId"]]));
    assert_eq!(revert["changes"][0]["baseVersion"], frozen["operationId"]);
    assert_eq!(revert["changes"][0]["after"], Value::Null);
}

#[test]
fn a_mixed_published_and_unsent_batch_reverses_only_the_receipted_keys_and_preserves_manual_entries(
) {
    let mut db = database();
    let mut remote = database();
    let mut seed = publish(&mut db);
    seed["supportsAiRevert"] = json!(true);
    pull(&mut db, &seed).unwrap();
    bind(&mut remote, URL, &seed, "replace").unwrap();
    let platform = ledger::snapshot(&mut db).unwrap().platforms.remove(0).id;
    let revision = ledger::review::revision(&db).unwrap();
    let write = ledger::review::LedgerWrite::new(&db, Some(&revision));
    ledger::add_bills(
        write,
        &[
            bill(&platform, "single", 1),
            bill(&platform, "single", 1),
            bill(&platform, "single", 1),
        ],
    )
    .unwrap();
    ledger::add_bill(&db, bill(&platform, "single", 1)).unwrap();
    let token = ai_preview(&mut db)["token"].as_str().unwrap().to_owned();
    let prefix = format!("ai.{token}.");
    let mut published = Vec::new();
    for cursor in 2..4 {
        let op = next(&db).unwrap().unwrap();
        assert!(op["operationId"].as_str().unwrap().starts_with(&prefix));
        let receipt = accepted(&op, cursor);
        ack(&mut db, &receipt).unwrap();
        pull(&mut remote, &page(cursor, &receipt["records"])).unwrap();
        published.push(op["operationId"].as_str().unwrap().to_string());
    }
    ledger::ai_undo::apply(&mut db, &token).unwrap();
    assert_eq!(entries(&mut db).len(), 1);
    let manual = next(&db).unwrap().unwrap();
    assert!(manual["revertOperationIds"].is_null());
    let receipt = accepted(&manual, 4);
    ack(&mut db, &receipt).unwrap();
    pull(&mut remote, &page(4, &receipt["records"])).unwrap();
    let inverse = next(&db).unwrap().unwrap();
    published.sort();
    assert_eq!(inverse["revertOperationIds"], json!(published));
    assert_eq!(inverse["changes"].as_array().unwrap().len(), 2);
    let mut receipt = accepted(&inverse, 5);
    for row in receipt["records"].as_array_mut().unwrap() {
        assert_eq!(row["value"], Value::Null);
        row["version"] = Value::Null;
    }
    ack(&mut db, &receipt).unwrap();
    pull(&mut remote, &page(5, &receipt["records"])).unwrap();
    assert_eq!(entries(&mut remote), entries(&mut db));
}

#[test]
fn an_identical_remote_write_is_never_owned_by_the_ai_on_this_device() {
    let mut db = database();
    publish(&mut db);
    let revision = ledger::review::revision(&db).unwrap();
    ledger::add_platform(
        ledger::review::LedgerWrite::new(&db, Some(&revision)),
        "两台设备同名",
    )
    .unwrap();
    let op = next(&db).unwrap().unwrap();
    let mut receipt = accepted(&op, 2);
    receipt["changedIds"] = json!([]);
    receipt["records"][0]["version"] = json!("remote-writer");
    ack(&mut db, &receipt).unwrap();
    assert_eq!(ai_preview(&mut db)["blockedReason"], "AI_UNDO_CONFLICT");
}

#[test]
fn remote_platform_revert_keeps_offline_bills_until_the_device_resolves_them() {
    for choice in ["local", "remote"] {
        let mut db = database();
        publish(&mut db);
        let id = ledger::snapshot(&mut db).unwrap().platforms.remove(0).id;
        ledger::add_bill(&db, bill(&id, "single", 1)).unwrap();
        let child = next(&db).unwrap().unwrap();
        let bill_id = &child["changes"][0]["id"];
        let reply = json!({"cursor":2,"code":"conflict","records":[
            {"kind":"entry","id":bill_id,"value":null,"version":null}]});
        let op_id = child["operationId"].as_str().unwrap();
        conflict(&mut db, op_id, &reply).unwrap();
        let deleted = page(
            2,
            &json!([{"kind":"platform","id":id,"value":null,"version":null}]),
        );
        pull(&mut db, &deleted).unwrap();
        let name: String = db
            .query_row("SELECT name FROM platforms WHERE id=?", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(
            status(&db).unwrap()["conflicts"][0]["restoresPlatforms"],
            json!([name])
        );
        assert_eq!(entries(&mut db).len(), 1);
        resolve(&mut db, op_id, choice).unwrap();
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM platforms WHERE id=?)",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        if choice == "local" {
            assert!(exists);
            let kept = next(&db).unwrap().unwrap();
            assert_eq!(kept["changes"].as_array().unwrap().len(), 2);
            assert_eq!(kept["changes"][0]["kind"], "platform");
            assert_eq!(kept["changes"][0]["after"]["name"], name);
            assert_eq!(kept["changes"][1]["id"], *bill_id);
            ack(&mut db, &accepted(&kept, 3)).unwrap();
            assert_eq!(entries(&mut db).len(), 1);
        } else {
            assert!(!exists);
            assert!(entries(&mut db).is_empty());
            assert!(next(&db).unwrap().is_none());
        }
    }
}

#[test]
fn a_remote_manual_bill_arrives_while_a_platform_revert_is_disputed() {
    let mut db = database();
    let mut seed = publish(&mut db);
    seed["supportsAiRevert"] = json!(true);
    pull(&mut db, &seed).unwrap();
    let revision = ledger::review::revision(&db).unwrap();
    let id = ledger::add_platform(
        ledger::review::LedgerWrite::new(&db, Some(&revision)),
        "AI 账单平台",
    )
    .unwrap();
    let original = next(&db).unwrap().unwrap();
    let acceptance = accepted(&original, 2);
    ack(&mut db, &acceptance).unwrap();
    let ticket = ai_preview(&mut db);
    ledger::ai_undo::apply(&mut db, ticket["token"].as_str().unwrap()).unwrap();
    let revert = next(&db).unwrap().unwrap();
    let revert_id = revert["operationId"].as_str().unwrap();
    conflict(
        &mut db,
        revert_id,
        &json!({"code":"conflict","cursor":3,"records":acceptance["records"]}),
    )
    .unwrap();
    let child = json!({"kind":"entry","id":"manual","version":"remote","value":{
        "kind":"single","id":"manual","platformId":id,"month":"2026-12","title":"手记",
        "status":"due","amountCents":150,"installmentIndex":null,"installmentCount":null
    }});
    pull(&mut db, &page(3, &json!([child]))).unwrap();
    assert_eq!(entries(&mut db)[0]["title"], "手记");
    assert_eq!(status(&db).unwrap()["conflicts"][0]["aiRevert"], true);
    assert_eq!(
        resolve(&mut db, revert_id, "local")
            .unwrap_err()
            .to_string(),
        "AI_UNDO_SYNC_CONFLICT"
    );
    resolve(&mut db, revert_id, "remote").unwrap();
    assert_eq!(entries(&mut db)[0]["platformId"], id);
    assert!(next(&db).unwrap().is_none());
}

fn entries(db: &mut Connection) -> Vec<Value> {
    ledger::snapshot(db)
        .unwrap()
        .entries
        .into_iter()
        .map(|entry| serde_json::to_value(entry).unwrap())
        .collect()
}

#[test]
fn migrating_a_v1_ledger_keeps_original_ids_and_stays_unbound() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../../schema_v1.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../initial_data.sql"))
        .unwrap();
    db.execute(
        "INSERT INTO platforms(id,name) VALUES ('legacy-id','已有平台')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO entries(id, platform_id, title, month, amount_cents, status, kind)
                VALUES ('legacy-item','legacy-id','原款项','2026-12',4280,'due','single')",
        [],
    )
    .unwrap();
    ledger::migrate(&mut db).unwrap();
    ledger::migrate(&mut db).unwrap();
    assert_eq!(entries(&mut db)[0]["id"], "legacy-item");
    assert!(status(&db).unwrap()["ledgerId"].is_null());
    assert_eq!(status(&db).unwrap()["pending"], 0);
    let snapshot = publish(&mut db);
    assert!(snapshot["records"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "entry"
            && r["value"]["id"] == "legacy-item"
            && r["value"]["platformId"] == "legacy-id"));
}

fn v2_database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../../schema_v1.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../initial_data.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../schema_v2.sql"))
        .unwrap();
    db
}

#[test]
fn migrating_a_v2_queue_preserves_pending_period_ids_conflicts_and_cursor() {
    let mut db = v2_database();
    let old_columns: i32 = db.query_row(
        "SELECT count(*) FROM pragma_table_info('sync_queue') WHERE name IN ('wire_json','undo_of')",
        [], |r| r.get(0)).unwrap();
    assert_eq!(
        old_columns, 0,
        "this fixture exercises the original v2 table"
    );
    db.execute(
        "INSERT INTO sync_binding(singleton,url,ledger_id,cursor) VALUES(1,?1,?2,7)",
        [URL, LEDGER],
    )
    .unwrap();
    db.execute_batch("INSERT INTO platforms(id,name) VALUES('old-platform','已有平台');
        INSERT INTO entries(id,platform_id,title,month,amount_cents,status,kind,installment_index,installment_count)
        VALUES ('old-period-1','old-platform','跨年分期','2026-12',1500,'due','installment',1,2),
               ('old-period-2','old-platform','跨年分期','2027-01',1500,'due','installment',2,2);
        UPDATE settings SET default_salary_cents=200 WHERE id=1;
        INSERT INTO sync_shadow(kind,id,value_json,version,seen_cursor)
        SELECT kind,id,value_json,'seed',1 FROM sync_local WHERE kind='platform';
        INSERT INTO sync_shadow(kind,id,value_json,version,seen_cursor)
        VALUES('setting','defaultSalaryCents','300','remote-budget',7);
        INSERT INTO sync_queue(operation_id) VALUES('old-budget-conflict'), ('old-installment-op');
        INSERT INTO sync_changes(operation_id,kind,id,base_version,before_json,after_json)
        VALUES('old-budget-conflict','setting','defaultSalaryCents','old-budget','100','200');
        INSERT INTO sync_changes(operation_id,kind,id,base_version,before_json,after_json)
        SELECT 'old-installment-op',kind,id,NULL,'null',value_json FROM sync_local WHERE kind='entry';").unwrap();
    let conflict_body = json!({"code":"conflict","cursor":7,"records":[{
        "kind":"setting","id":"defaultSalaryCents","value":300,"version":"remote-budget"
    }]});
    db.execute(
        "UPDATE sync_queue SET conflict_json=?1 WHERE operation_id='old-budget-conflict'",
        [conflict_body.to_string()],
    )
    .unwrap();
    let old_entries: Vec<Value> = db
        .prepare("SELECT value_json FROM sync_local WHERE kind='entry' ORDER BY id")
        .unwrap()
        .query_map([], |r| super::decode_json(r.get(0)?))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let expected: Vec<_> = old_entries
        .into_iter()
        .map(|value| {
            json!({
                "kind":"entry", "id":value["id"], "baseVersion":null, "before":null, "after":value
            })
        })
        .collect();

    ledger::migrate(&mut db).unwrap();
    let version: u32 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 8);
    let saved = status(&db).unwrap();
    assert_eq!(saved["cursor"], 7);
    assert_eq!(saved["pending"], 2);
    assert_eq!(saved["conflicts"][0]["records"], conflict_body["records"]);
    let request = next(&db).unwrap().unwrap();
    assert_eq!(request["operationId"], "old-installment-op");
    assert_eq!(request["changes"], json!(expected));
    ledger::migrate(&mut db).unwrap();
    assert_eq!(next(&db).unwrap(), Some(request.clone()));
    let receipt = accepted(&request, 8);
    ack(&mut db, &receipt).unwrap();
    ack(&mut db, &receipt).unwrap();
    assert_eq!(entries(&mut db).len(), 2);
    assert_eq!(status(&db).unwrap()["pending"], 1); // budget still needs a user decision
    assert_eq!(status(&db).unwrap()["cursor"], 7);
}

#[test]
fn upgrading_an_extended_v2_database_keeps_its_exact_frozen_request_and_payment_owner() {
    let mut db = v2_database();
    db.execute_batch(
        "ALTER TABLE sync_queue ADD COLUMN undo_of TEXT;
                      ALTER TABLE sync_queue ADD COLUMN wire_json TEXT;",
    )
    .unwrap();
    db.execute_batch(include_str!("../../schema_v3.sql"))
        .unwrap();
    db.pragma_update(None, "user_version", 2).unwrap();
    let id = "old-paid-bill".to_owned();
    db.execute(
        "INSERT INTO sync_binding(singleton,url,ledger_id,cursor) VALUES(1,?1,?2,1)",
        [URL, LEDGER],
    )
    .unwrap();
    db.execute_batch(
        "INSERT INTO entries(id,platform_id,title,month,amount_cents,status,kind)
        SELECT 'old-paid-bill',id,'旧账单','2026-12',100,'due','single' FROM platforms LIMIT 1;
        INSERT INTO sync_shadow(kind,id,value_json,version,seen_cursor)
        SELECT kind,id,value_json,'seed',1 FROM sync_local WHERE kind='entry';
        UPDATE entries SET status='paid';
        INSERT INTO sync_queue(operation_id) VALUES('old-payment');
        INSERT INTO sync_last_payment VALUES('old-paid-bill','old-payment');
        INSERT INTO sync_changes(operation_id,kind,id,base_version,before_json,after_json)
        SELECT 'old-payment',l.kind,l.id,s.version,s.value_json,l.value_json
        FROM sync_local l JOIN sync_shadow s USING(kind,id) WHERE l.kind='entry';",
    )
    .unwrap();
    // Freeze a v2-format wire image without running a current client on a v2 schema.
    let change = db.query_row(
        "SELECT kind,id,base_version,before_json,after_json FROM sync_changes WHERE operation_id='old-payment'",
        [], super::read_change,
    ).unwrap();
    let request = json!({"operationId":"old-payment","seed":false,"changes":[change]});
    db.execute(
        "UPDATE sync_queue SET wire_json=? WHERE operation_id='old-payment'",
        [request.to_string()],
    )
    .unwrap();
    let frozen_wire = |conn: &Connection| -> String {
        conn.query_row(
            "SELECT wire_json FROM sync_queue WHERE wire_json IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    let original_wire = frozen_wire(&db);
    // A development-era v2 file may already have both columns, their index,
    // and the payment ownership table. Full setup must remain idempotent.
    ledger::migrate(&mut db).unwrap();
    let state = status(&db).unwrap();
    assert_eq!(state["undoableIds"], json!([id]));
    ledger::migrate(&mut db).unwrap();
    assert_eq!(status(&db).unwrap(), state);
    assert_eq!(frozen_wire(&db), original_wire);
    assert_eq!(next(&db).unwrap().unwrap(), request);
    ack(&mut db, &accepted(&request, 2)).unwrap();
    assert_eq!(
        ledger::undo_payment(&mut db, std::slice::from_ref(&id), false).unwrap(),
        vec![id]
    );
}

#[test]
fn a_lost_installment_receipt_reuses_the_operation_and_all_twelve_period_ids_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("windows.sqlite3");
    let mut windows = Connection::open(&file).unwrap();
    ledger::migrate(&mut windows).unwrap();
    let seed = publish(&mut windows);
    let mut android = database();
    bind(&mut android, URL, &seed, "replace").unwrap();
    let platform = ledger::snapshot(&mut windows)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    ledger::add_bill(&mut windows, bill(&platform, "installment", 12)).unwrap();
    let operation = next(&windows).unwrap().unwrap();
    let receipt = accepted(&operation, 2);
    drop(windows); // Server committed, but the HTTP response was lost.

    let mut windows = Connection::open(&file).unwrap();
    ledger::migrate(&mut windows).unwrap();
    let retry = next(&windows).unwrap().unwrap();
    assert_eq!(retry, operation);
    let changes = retry["changes"].as_array().unwrap();
    let ids: HashSet<_> = changes
        .iter()
        .map(|change| change["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 12);
    assert_eq!(changes.len(), 12);
    assert!(changes.iter().all(|change| change["kind"] == "entry"
        && change["before"].is_null()
        && change["after"]["id"] == change["id"]));
    ack(&mut windows, &receipt).unwrap(); // Server returns the stored receipt.
    let update = page(2, &receipt["records"]);
    pull(&mut windows, &update).unwrap();
    pull(&mut android, &update).unwrap();
    assert!(next(&windows).unwrap().is_none());
    assert!(next(&android).unwrap().is_none());
    let expected = entries(&mut windows);
    assert_eq!(expected.len(), 12);
    assert_eq!(expected[0]["month"], "2026-12");
    assert_eq!(expected[11]["month"], "2027-11");
    assert_eq!(entries(&mut android), expected);
}

#[test]
fn imported_billed_periods_sync_from_the_statement_month_through_the_last_installment() {
    let mut source = database();
    let seed = publish(&mut source);
    let mut target = database();
    bind(&mut target, URL, &seed, "replace").unwrap();
    let platform = ledger::snapshot(&mut source)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    let mut ongoing = bill(&platform, "installment", 3);
    ongoing.installment_index = Some(2);
    let mut last = bill(&platform, "installment", 3);
    last.installment_index = Some(3);
    last.month = "2099-12".into();
    ledger::add_bills(&mut source, &[ongoing, last, bill(&platform, "single", 1)]).unwrap();
    let mut cursor = 1;
    while let Some(operation) = next(&source).unwrap() {
        cursor += 1;
        let receipt = accepted(&operation, cursor);
        ack(&mut source, &receipt).unwrap();
        pull(&mut target, &page(cursor, &receipt["records"])).unwrap();
    }
    let rows = entries(&mut source);
    assert_eq!(entries(&mut target), rows);
    assert_eq!(rows.len(), 4);
    let periods: Vec<_> = rows
        .iter()
        .filter(|row| row["kind"] == "installment")
        .collect();
    assert_eq!(
        periods
            .iter()
            .map(|row| (&row["month"], &row["installmentIndex"]))
            .collect::<Vec<_>>(),
        [
            (&json!("2026-12"), &json!(2)),
            (&json!("2027-01"), &json!(3)),
            (&json!("2099-12"), &json!(3))
        ]
    );
    assert!(periods
        .iter()
        .all(|row| row["installmentCount"] == 3 && row["amountCents"] == 30000));
    assert!(periods[0]["installmentId"].is_string());
    assert_eq!(periods[0]["installmentId"], periods[1]["installmentId"]);
    assert_ne!(periods[0]["installmentId"], periods[2]["installmentId"]);
}

fn confirmed_pair() -> (Connection, Connection, Value, String) {
    conflicting_terms([("2026-12", 32000, 1000), ("2027-01", 35000, 5500)])
}

#[test]
fn a_pending_ai_payment_that_converges_during_conflict_resolution_has_no_undo_right() {
    let (mut desktop, mut phone, _, id) = confirmed_pair();
    let revision = ledger::review::revision(&phone).unwrap();
    ledger::mark_payment(
        ledger::review::LedgerWrite::new(&phone, Some(&revision)),
        std::slice::from_ref(&id),
        true,
    )
    .unwrap();
    ledger::mark_payment(&mut desktop, std::slice::from_ref(&id), true).unwrap();
    let paid = accepted(&next(&desktop).unwrap().unwrap(), 3);
    let disputed = next(&phone).unwrap().unwrap();
    let op_id = disputed["operationId"].as_str().unwrap();
    conflict(
        &mut phone,
        op_id,
        &json!({"code":"conflict","cursor":3,"records":paid["records"]}),
    )
    .unwrap();
    resolve(&mut phone, op_id, "remote").unwrap();
    assert!(next(&phone).unwrap().is_none());
    assert_eq!(entries(&mut phone)[0]["status"], "paid");
    assert_eq!(ai_preview(&mut phone)["blockedReason"], "AI_UNDO_CONFLICT");
}

fn conflicting_terms(terms: [(&str, i64, i64); 2]) -> (Connection, Connection, Value, String) {
    let mut windows = database();
    let platform = ledger::snapshot(&mut windows)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    ledger::add_bill(&mut windows, bill(&platform, "estimate", 1)).unwrap();
    let seed = publish(&mut windows);
    let mut android = database();
    bind(&mut android, URL, &seed, "replace").unwrap();
    let id = entries(&mut android)[0]["id"].as_str().unwrap().to_owned();
    for (device, (month, amount_cents, deposit)) in
        [&mut windows, &mut android].into_iter().zip(terms)
    {
        ledger::confirm(
            device,
            ConfirmInput {
                id: id.clone(),
                title: "画册".into(),
                month: month.into(),
                amount_cents,
                total_cents: Some(amount_cents + deposit),
                deposit_cents: Some(deposit),
            },
        )
        .unwrap();
    }
    let receipt = accepted(&next(&windows).unwrap().unwrap(), 2);
    ack(&mut windows, &receipt).unwrap();
    pull(&mut windows, &page(2, &receipt["records"])).unwrap();
    (windows, android, receipt, id)
}

#[test]
fn choosing_between_equal_balances_keeps_the_reviewed_deposit() {
    let (_, mut phone, remote, _) =
        conflicting_terms([("2027-01", 32000, 1000), ("2027-01", 32000, 5500)]);
    let request = next(&phone).unwrap().unwrap();
    let op_id = request["operationId"].as_str().unwrap();
    conflict(
        &mut phone,
        op_id,
        &json!({"code":"conflict","cursor":2,"records":remote["records"]}),
    )
    .unwrap();
    let state = status(&phone).unwrap();
    let choice = &state["conflicts"][0];
    assert_eq!(choice["changes"][0]["after"]["depositCents"], 5500);
    assert_eq!(choice["records"][0]["value"]["depositCents"], 1000);
    resolve(&mut phone, op_id, "local").unwrap();
    let replacement = next(&phone).unwrap().unwrap();
    let change = &replacement["changes"][0];
    assert_eq!(
        change["before"]["amountCents"],
        change["after"]["amountCents"]
    );
    assert_eq!(change["after"]["depositCents"], 5500);
    assert_eq!(next(&phone).unwrap().unwrap(), replacement);
    ack(&mut phone, &accepted(&replacement, 3)).unwrap();
    assert_eq!(entries(&mut phone)[0]["depositCents"], 5500);
}

#[test]
fn resolving_a_prepaid_confirmation_keeps_payments_attached_to_the_relevant_balance() {
    for choice in ["local", "remote"] {
        let (_, mut phone, remote, id) =
            conflicting_terms([("2027-01", 0, 10000), ("2027-01", 8000, 2000)]);
        assert_eq!(remote["records"][0]["value"]["status"], "paid");
        let request = next(&phone).unwrap().unwrap();
        if choice == "remote" {
            // Both changes applied to the local positive balance before the remote receipt arrived.
            ledger::mark_payment(&mut phone, std::slice::from_ref(&id), true).unwrap();
            ledger::undo_payment(&mut phone, &[id], false).unwrap();
        }
        let op_id = request["operationId"].as_str().unwrap();
        conflict(
            &mut phone,
            op_id,
            &json!({"code":"conflict","cursor":2,"records":remote["records"]}),
        )
        .unwrap();
        resolve(&mut phone, op_id, choice).unwrap();
        if choice == "local" {
            let wire = next(&phone).unwrap().unwrap();
            assert_eq!(wire["changes"][0]["after"]["status"], "due");
            ack(&mut phone, &accepted(&wire, 3)).unwrap();
            let entry = &entries(&mut phone)[0];
            assert_eq!(entry["amountCents"], 8000);
            assert_eq!(entry["depositCents"], 2000);
        } else {
            assert_eq!(entries(&mut phone)[0], remote["records"][0]["value"]);
        }
        assert!(next(&phone).unwrap().is_none());
    }
}

#[test]
fn pulled_estimates_round_trip_deposits_and_invalid_splits_do_not_advance_the_cursor() {
    let mut source = database();
    let mut bill = bill(
        &ledger::snapshot(&mut source).unwrap().platforms[0].id,
        "estimate",
        1,
    );
    bill.amount_cents = 0;
    bill.deposit_cents = Some(12345);
    bill.total_cents = Some(12345);
    ledger::add_bill(&mut source, bill).unwrap();
    let seed = publish(&mut source);
    let mut device = database();
    bind(&mut device, URL, &seed, "replace").unwrap();
    let initial = entries(&mut device).remove(0);
    assert_eq!(initial["amountCents"], 0);
    assert_eq!(initial["depositCents"], 12345);
    assert_eq!(initial["status"], "estimated");
    let mut record = seed["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "entry")
        .unwrap()
        .clone();
    record["version"] = json!("adjustment");
    let send = |db: &mut Connection, record: &Value| pull(db, &page(2, &json!([record])));
    for (status, amount, deposit) in [
        ("due", 0, 12345),
        ("estimated", 12345, 0),
        ("estimated", 1, -1),
        ("estimated", 1, ledger::MAX_CENTS),
    ] {
        record["value"]["status"] = json!(status);
        record["value"]["amountCents"] = json!(amount);
        record["value"]["depositCents"] = json!(deposit);
        assert!(send(&mut device, &record).is_err());
        assert_eq!(entries(&mut device)[0], initial);
    }
    assert_eq!(status(&device).unwrap()["cursor"], 1);
    // The next valid row may come from a legacy device or clear a former deposit.
    record["value"]["amountCents"] = json!(12345);
    record["value"]
        .as_object_mut()
        .unwrap()
        .remove("depositCents");
    send(&mut device, &record).unwrap();
    assert_eq!(entries(&mut device)[0], record["value"]);
}

#[test]
fn a_voided_entry_survives_seed_and_restoration_propagates_without_replacing_its_id() {
    let mut source = database();
    let platform = ledger::snapshot(&mut source)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    ledger::add_bill(&mut source, bill(&platform, "estimate", 1)).unwrap();
    let original = entries(&mut source).remove(0);
    let id = original["id"].as_str().unwrap();
    ledger::set_entry_voided(&mut source, id, true).unwrap();
    let seed = publish(&mut source);
    let mut device = database();
    bind(&mut device, URL, &seed, "replace").unwrap();
    assert_eq!(entries(&mut device)[0]["voided"], true);

    ledger::set_entry_voided(&mut device, id, false).unwrap();
    let op = next(&device).unwrap().unwrap();
    assert_eq!(op["changes"][0]["before"]["voided"], true);
    assert_eq!(op["changes"][0]["after"], original);
    let receipt = accepted(&op, 2);
    ack(&mut device, &receipt).unwrap();
    pull(&mut source, &page(2, &receipt["records"])).unwrap();
    assert_eq!(entries(&mut source), vec![original]);
}

#[test]
fn resolving_a_void_conflict_preserves_the_other_devices_confirmation() {
    let mut source = database();
    let platform = ledger::snapshot(&mut source)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    ledger::add_bill(&mut source, bill(&platform, "estimate", 1)).unwrap();
    let seed = publish(&mut source);
    let mut device = database();
    bind(&mut device, URL, &seed, "replace").unwrap();
    let id = entries(&mut device)[0]["id"].as_str().unwrap().to_owned();
    ledger::set_entry_voided(&mut device, &id, true).unwrap();
    let pending = next(&device).unwrap().unwrap();
    ledger::confirm(
        &source,
        ConfirmInput {
            id: id.clone(),
            title: "新补款".into(),
            month: "2027-01".into(),
            amount_cents: 1200,
            total_cents: None,
            deposit_cents: None,
        },
    )
    .unwrap();
    let confirmed = accepted(&next(&source).unwrap().unwrap(), 2);
    let op_id = pending["operationId"].as_str().unwrap();
    conflict(
        &mut device,
        op_id,
        &json!({"code":"conflict","cursor":2,"records":confirmed["records"]}),
    )
    .unwrap();
    resolve(&mut device, op_id, "local").unwrap();
    let resolved = next(&device).unwrap().unwrap();
    let mut expected = confirmed["records"][0]["value"].clone();
    expected["voided"] = json!(true);
    assert_eq!(resolved["changes"][0]["after"], expected);
    assert_eq!(entries(&mut device), vec![expected]);
}

#[test]
fn a_remote_void_blocks_a_local_confirmation_and_its_later_payment() {
    let mut source = database();
    let platform = ledger::snapshot(&mut source)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    ledger::add_bill(&mut source, bill(&platform, "estimate", 1)).unwrap();
    let seed = publish(&mut source);
    let mut device = database();
    bind(&mut device, URL, &seed, "replace").unwrap();
    let id = entries(&mut device)[0]["id"].as_str().unwrap().to_owned();
    ledger::confirm(
        &device,
        ConfirmInput {
            id: id.clone(),
            title: "补款".into(),
            month: "2027-02".into(),
            amount_cents: 2345,
            total_cents: None,
            deposit_cents: None,
        },
    )
    .unwrap();
    let pending = next(&device).unwrap().unwrap();
    ledger::mark_payment(&mut device, std::slice::from_ref(&id), true).unwrap();
    ledger::set_entry_voided(&mut source, &id, true).unwrap();
    let voided = accepted(&next(&source).unwrap().unwrap(), 2);
    let op_id = pending["operationId"].as_str().unwrap();
    conflict(
        &mut device,
        op_id,
        &json!({"code":"conflict","cursor":2,"records":voided["records"]}),
    )
    .unwrap();
    assert_eq!(
        status(&device).unwrap()["conflicts"][0]["requiresRestore"],
        true
    );
    assert_eq!(
        resolve(&mut device, op_id, "local")
            .unwrap_err()
            .to_string(),
        "SYNC_ENTRY_VOIDED"
    );
    resolve(&mut device, op_id, "remote").unwrap();
    assert!(next(&device).unwrap().is_none());
    assert_eq!(
        entries(&mut device),
        vec![voided["records"][0]["value"].clone()]
    );
}

#[test]
fn conflicting_confirmations_preserve_local_draft_and_can_choose_remote() {
    let (mut windows, mut android, receipt, _) = confirmed_pair();
    let operation = next(&android).unwrap().unwrap();
    let operation_id = operation["operationId"].as_str().unwrap();
    conflict(
        &mut android,
        operation_id,
        &json!({
            "code": "conflict", "cursor": 2, "records": receipt["records"]
        }),
    )
    .unwrap();
    pull(&mut android, &page(2, &receipt["records"])).unwrap();
    assert_eq!(
        status(&android).unwrap()["conflicts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(entries(&mut android)[0]["amountCents"], 35000);
    resolve(&mut android, operation_id, "remote").unwrap();
    // A remote selection may be acknowledged by the server as a no-op.
    if let Some(resolution) = next(&android).unwrap() {
        let reply = json!({"operationId": resolution["operationId"], "cursor": 2, "records": receipt["records"], "changedIds":[]});
        ack(&mut android, &reply).unwrap();
    }
    assert_eq!(entries(&mut android), entries(&mut windows));
    assert_eq!(entries(&mut android)[0]["month"], "2026-12");
    assert_eq!(entries(&mut android)[0]["depositCents"], 1000);
    assert!(status(&android).unwrap()["conflicts"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn choosing_local_rebases_the_confirm_and_keeps_a_later_offline_payment() {
    let (mut windows, mut android, remote, id) = confirmed_pair();
    let proposed = next(&android).unwrap().unwrap();
    let original_id = proposed["operationId"].as_str().unwrap();
    ledger::mark_payment(&mut android, std::slice::from_ref(&id), true).unwrap();
    conflict(
        &mut android,
        original_id,
        &json!({"code":"conflict", "cursor": 2, "records":remote["records"]}),
    )
    .unwrap();
    resolve(&mut android, original_id, "local").unwrap();

    let mut server_record = remote["records"][0].clone();
    for cursor in 3..=4 {
        let Some(operation) = next(&android).unwrap() else {
            break;
        };
        assert_ne!(operation["operationId"], original_id);
        let change = &operation["changes"][0];
        assert_eq!(change["id"], id);
        assert_eq!(change["before"], server_record["value"]);
        assert_eq!(change["baseVersion"], server_record["version"]);
        let receipt = accepted(&operation, cursor);
        server_record = receipt["records"][0].clone();
        ack(&mut android, &receipt).unwrap();
        let update = page(cursor, &receipt["records"]);
        pull(&mut windows, &update).unwrap();
        pull(&mut android, &update).unwrap();
    }
    let final_entries = entries(&mut windows);
    assert_eq!(final_entries.len(), 1);
    assert_eq!(final_entries[0]["id"], id);
    assert_eq!(final_entries[0]["month"], "2027-01");
    assert_eq!(final_entries[0]["amountCents"], 35000);
    assert_eq!(final_entries[0]["depositCents"], 5500);
    assert_eq!(final_entries[0]["status"], "paid");
    assert_eq!(entries(&mut android), final_entries);
    assert!(next(&android).unwrap().is_none());
}

#[test]
fn bound_ledger_blocks_whole_ledger_import_and_reset_until_disconnected() {
    let mut db = database();
    let backup = backup::export(&mut db).unwrap();
    publish(&mut db);
    assert!(backup::restore(&mut db, &backup).is_err());
    assert!(backup::reset(&mut db, "重置").is_err());
    assert!(next(&db).unwrap().is_none());
    unbind(&mut db).unwrap();
    backup::restore(&mut db, &backup).unwrap();
    backup::reset(&mut db, "重置").unwrap();
    assert!(status(&db).unwrap()["ledgerId"].is_null());
}

#[test]
fn a_no_op_payment_receipt_discards_its_queued_undo_without_reopening_the_other_devices_payment() {
    let mut windows = database();
    let platform = ledger::snapshot(&mut windows)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    ledger::add_bill(&mut windows, bill(&platform, "single", 1)).unwrap();
    let seed = publish(&mut windows);
    let mut android = database();
    bind(&mut android, URL, &seed, "replace").unwrap();
    let ids = [entries(&mut android)[0]["id"].as_str().unwrap().to_owned()];
    ledger::mark_payment(&mut windows, &ids, true).unwrap();
    ledger::mark_payment(&mut android, &ids, true).unwrap();
    ledger::undo_payment(&mut android, &ids, false).unwrap();
    let primary_receipt = accepted(&next(&windows).unwrap().unwrap(), 2);
    ack(&mut windows, &primary_receipt).unwrap();
    let android_payment = next(&android).unwrap().unwrap();
    let no_op = json!({"operationId": android_payment["operationId"], "cursor": 2,
        "records": primary_receipt["records"], "changedIds": []});
    ack(&mut android, &no_op).unwrap();
    ack(&mut android, &no_op).unwrap();
    assert!(next(&android).unwrap().is_none());
    assert_eq!(entries(&mut android)[0]["status"], "paid");
    assert_eq!(entries(&mut android), entries(&mut windows));
    assert!(!status(&android).unwrap()["undoableIds"]
        .as_array()
        .unwrap()
        .contains(&json!(ids[0])));
    assert!(ledger::undo_payment(&mut android, &ids, false)
        .unwrap()
        .is_empty());
    assert_eq!(
        ledger::undo_payment(&mut windows, &ids, false).unwrap(),
        ids
    );
}

#[test]
fn the_same_new_platform_on_two_bound_devices_has_one_shared_identity() {
    let mut windows = database();
    let seed = publish(&mut windows);
    let mut android = database();
    bind(&mut android, URL, &seed, "replace").unwrap();
    let windows_id = ledger::add_platform(&mut windows, "同步测试平台").unwrap();
    let android_id = ledger::add_platform(&mut android, "同步测试平台").unwrap();
    assert_eq!(windows_id, android_id);
}

#[test]
fn an_invalid_page_neither_advances_the_cursor_nor_partially_updates_the_local_ledger() {
    let mut db = database();
    publish(&mut db);
    let original = serde_json::to_value(ledger::snapshot(&mut db).unwrap()).unwrap();
    let records = json!([
        {"kind":"platform", "id":"test-platform", "version":"op1",
            "value":{"id":"test-platform","name":"新增平台"}},
        {"kind":"entry","id":"test-entry","version":"op1","value":{
            "id":"test-entry","platformId":"missing-platform","title":"原子回滚","month":"2026-12",
            "amountCents":123,"kind":"single","status":"due","installmentIndex":null,"installmentCount":null}}
    ]);
    assert!(pull(&mut db, &page(2, &records)).is_err());
    assert_eq!(status(&db).unwrap()["cursor"], 1);
    assert_eq!(
        serde_json::to_value(ledger::snapshot(&mut db).unwrap()).unwrap(),
        original
    );
}

#[test]
fn a_partial_installment_sync_accepts_consistent_periods_and_rejects_conflicting_metadata() {
    let mut db = database();
    publish(&mut db);
    let platform = ledger::snapshot(&mut db).unwrap().platforms.remove(0).id;
    let period = |id: &str, index: u32, month: &str, cents: i64| {
        json!({
            "kind": "entry", "id": id, "version": "published",
            "value": {
                "id": id, "platformId": platform, "title": "分期", "month": month,
                "amountCents": cents, "kind": "installment", "status": "due",
                "installmentIndex": index, "installmentCount": 2,
                "installmentId": "0123456789abcdef0123456789abcdef"
            }
        })
    };
    pull(
        &mut db,
        &page(2, &json!([period("first", 1, "2026-12", 150)])),
    )
    .unwrap();
    assert!(pull(
        &mut db,
        &page(3, &json!([period("second", 2, "2027-01", 190)]))
    )
    .is_err());
    assert_eq!(status(&db).unwrap()["cursor"], 2);
    assert_eq!(entries(&mut db).len(), 1);
    pull(
        &mut db,
        &page(3, &json!([period("second", 2, "2027-01", 150)])),
    )
    .unwrap();
    assert_eq!(entries(&mut db).len(), 2);
}

#[test]
fn a_changed_server_candidate_requires_another_manual_choice() {
    let (_, mut android, original, _) = confirmed_pair();
    let proposed = next(&android).unwrap().unwrap();
    let id = proposed["operationId"].as_str().unwrap();
    conflict(
        &mut android,
        id,
        &json!({"code":"conflict", "cursor":2, "records":original["records"]}),
    )
    .unwrap();
    let mut newer = original["records"].clone();
    newer[0]["version"] = json!("newer-server-write");
    newer[0]["value"]["amountCents"] = json!(36000);
    pull(&mut android, &page(3, &newer)).unwrap();
    assert!(resolve(&mut android, id, "local").is_err());
    assert_eq!(
        status(&android).unwrap()["conflicts"][0]["records"][0]["value"]["amountCents"],
        36000
    );
    resolve(&mut android, id, "remote").unwrap();
    assert_eq!(entries(&mut android)[0]["amountCents"], 36000);
}

#[test]
fn an_unrelated_entry_can_upload_while_a_confirmation_and_its_dependent_payment_wait() {
    let (_, mut android, remote, id) = confirmed_pair();
    let proposed = next(&android).unwrap().unwrap();
    let operation_id = proposed["operationId"].as_str().unwrap();
    let platform = ledger::snapshot(&mut android)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    ledger::mark_payment(&mut android, std::slice::from_ref(&id), true).unwrap();
    ledger::add_bill(&mut android, bill(&platform, "single", 1)).unwrap();
    conflict(
        &mut android,
        operation_id,
        &json!({
            "code":"conflict", "cursor":2, "records":remote["records"]
        }),
    )
    .unwrap();
    let unrelated = next(&android)
        .unwrap()
        .expect("the new entry is independent");
    assert_ne!(unrelated["operationId"], operation_id);
    assert_eq!(unrelated["changes"].as_array().unwrap().len(), 1);
    assert_eq!(unrelated["changes"][0]["after"]["kind"], "single");
    assert_ne!(unrelated["changes"][0]["id"], id);
    ack(&mut android, &accepted(&unrelated, 3)).unwrap();
    assert!(next(&android).unwrap().is_none());
    assert_eq!(
        status(&android).unwrap()["conflicts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    resolve(&mut android, operation_id, "remote").unwrap();
    let payment = next(&android)
        .unwrap()
        .expect("resolution unblocks the payment");
    assert_eq!(payment["changes"][0]["id"], id);
    assert_eq!(
        payment["changes"][0]["before"],
        remote["records"][0]["value"]
    );
    assert_eq!(payment["changes"][0]["after"]["status"], "paid");
    assert_eq!(payment["changes"][0]["after"]["amountCents"], 32000);
    assert_eq!(payment["changes"][0]["after"]["depositCents"], 1000);
}

#[test]
fn resolving_either_of_two_conflicts_keeps_an_existing_in_flight_request_frozen() {
    let mut windows = database();
    let platform = ledger::snapshot(&mut windows)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    for title in ["第一笔", "第二笔"] {
        let mut input = bill(&platform, "estimate", 1);
        input.title = title.into();
        ledger::add_bill(&mut windows, input).unwrap();
    }
    let seed = publish(&mut windows);
    let mut android = database();
    bind(&mut android, URL, &seed, "replace").unwrap();
    let mut disputed_ids = Vec::new();
    for (index, entry) in entries(&mut windows).into_iter().enumerate() {
        for (db, amount) in [(&mut windows, 32000), (&mut android, 35000)] {
            ledger::confirm(
                db,
                ConfirmInput {
                    id: entry["id"].as_str().unwrap().into(),
                    title: entry["title"].as_str().unwrap().into(),
                    month: "2027-01".into(),
                    amount_cents: amount,
                    total_cents: None,
                    deposit_cents: None,
                },
            )
            .unwrap();
        }
        let current = accepted(&next(&windows).unwrap().unwrap(), index as i64 + 2);
        ack(&mut windows, &current).unwrap();
        let operation = next(&android).unwrap().unwrap();
        let operation_id = operation["operationId"].as_str().unwrap();
        conflict(
            &mut android,
            operation_id,
            &json!({
                "code":"conflict","cursor":current["cursor"],"records":current["records"]
            }),
        )
        .unwrap();
        disputed_ids.push(operation_id.to_owned());
    }
    assert_eq!(
        status(&android).unwrap()["conflicts"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    ledger::add_bill(&mut android, bill(&platform, "single", 1)).unwrap();
    let in_flight = next(&android).unwrap().unwrap();
    resolve(&mut android, &disputed_ids[1], "local").unwrap();
    assert_eq!(next(&android).unwrap().unwrap(), in_flight);
    resolve(&mut android, &disputed_ids[0], "remote").unwrap();
    assert_eq!(next(&android).unwrap().unwrap(), in_flight);
    ack(&mut android, &accepted(&in_flight, 4)).unwrap();
    let unblocked = next(&android).unwrap().unwrap();
    assert_ne!(unblocked["operationId"], in_flight["operationId"]);
    assert_eq!(unblocked["changes"][0]["before"]["amountCents"], 32000);
    assert_eq!(unblocked["changes"][0]["after"]["amountCents"], 35000);
}

#[test]
fn a_platform_conflict_blocks_only_new_bills_referencing_that_platform() {
    let mut windows = database();
    let initial_platform = ledger::snapshot(&mut windows)
        .unwrap()
        .platforms
        .remove(0)
        .id;
    let seed = publish(&mut windows);
    let mut android = database();
    bind(&mut android, URL, &seed, "replace").unwrap();
    let shared_id = ledger::add_platform(&windows, "CaseShop").unwrap();
    assert_eq!(
        ledger::add_platform(&android, "caseshop").unwrap(),
        shared_id
    );
    ledger::add_bill(&mut android, bill(&shared_id, "single", 1)).unwrap();
    ledger::add_bill(&mut android, bill(&initial_platform, "single", 1)).unwrap();
    let remote = accepted(&next(&windows).unwrap().unwrap(), 2);
    let disputed = next(&android).unwrap().unwrap();
    let disputed_id = disputed["operationId"].as_str().unwrap();
    conflict(
        &mut android,
        disputed_id,
        &json!({
            "code":"conflict","cursor":2,"records":remote["records"]
        }),
    )
    .unwrap();
    let allowed = next(&android).unwrap().unwrap();
    assert_eq!(
        allowed["changes"][0]["after"]["platformId"],
        initial_platform
    );
    ack(&mut android, &accepted(&allowed, 3)).unwrap();
    assert!(next(&android).unwrap().is_none());
    resolve(&mut android, disputed_id, "remote").unwrap();
    let unblocked = next(&android).unwrap().unwrap();
    assert_eq!(unblocked["changes"][0]["after"]["platformId"], shared_id);
    assert_eq!(
        ledger::snapshot(&mut android)
            .unwrap()
            .platforms
            .into_iter()
            .find(|p| p.id == shared_id)
            .unwrap()
            .name,
        "CaseShop"
    );
}
