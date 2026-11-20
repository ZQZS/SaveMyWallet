use super::{ack, bind, conflict, next, pull, resolve, status, unbind};
use crate::ledger::{self, backup, BillInput, ConfirmInput};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;

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
        kind: kind.into(),
        installment_count: count,
    }
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
    db.execute("INSERT INTO sync_binding VALUES(1,?1,?2,7)", [URL, LEDGER])
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
    assert_eq!(version, 5);
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
    db.execute("INSERT INTO sync_binding VALUES(1,?1,?2,1)", [URL, LEDGER])
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
    let request = next(&db).unwrap().unwrap();
    let frozen_wire = |conn: &Connection| -> String {
        conn.query_row(
            "SELECT wire_json FROM sync_queue WHERE wire_json IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    let original_wire = frozen_wire(&db);
    let state = status(&db).unwrap();
    assert_eq!(state["undoableIds"], json!([id]));
    // A development-era v2 file may already have both columns, their index,
    // and the payment ownership table. Full setup must remain idempotent.
    ledger::migrate(&mut db).unwrap();
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

fn confirmed_pair() -> (Connection, Connection, Value, String) {
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
    for (device, month, amount_cents) in [
        (&mut windows, "2026-12", 32000),
        (&mut android, "2027-01", 35000),
    ] {
        ledger::confirm(
            device,
            ConfirmInput {
                id: id.clone(),
                title: "画册".into(),
                month: month.into(),
                amount_cents,
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
