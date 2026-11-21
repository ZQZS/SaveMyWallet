use super::*;
use crate::ledger::{
    add_bill, add_platform, budget, confirm, mark_payment, migrate, review, set_entry_voided,
    snapshot, BillInput, BudgetInput, ConfirmInput, LedgerWrite,
};

fn database() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn).unwrap();
    conn
}

fn bill(platform: &str, title: &str) -> BillInput {
    BillInput {
        platform_id: platform.into(),
        title: title.into(),
        month: "2026-11".into(),
        amount_cents: 100,
        total_cents: None,
        deposit_cents: None,
        kind: "single".into(),
        installment_count: 1,
        installment_index: None,
    }
}

fn pay(conn: &Connection, ids: &[String]) {
    let revision = review::revision(conn).unwrap();
    mark_payment(LedgerWrite::new(conn, Some(&revision)), ids, true).unwrap();
}

fn entries(conn: &mut Connection, count: usize) -> (String, Vec<String>) {
    let platform = add_platform(&*conn, "平台").unwrap();
    for i in 0..count {
        add_bill(&*conn, bill(&platform, &format!("账单{i}"))).unwrap();
    }
    let ids = snapshot(conn)
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.id)
        .collect();
    (platform, ids)
}

#[test]
fn reopened_ticket_preserves_manual_rows_and_independent_fields_and_is_single_use() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("undo.sqlite");
    let mut writer = Connection::open(&path).unwrap();
    migrate(&mut writer).unwrap();
    let (platform, ids) = entries(&mut writer, 2);
    pay(&writer, &ids);
    let token = preview(&mut writer).unwrap().unwrap().token;
    add_bill(&writer, bill(&platform, "稍后手记")).unwrap();
    set_entry_voided(&writer, &ids[0], true).unwrap();
    drop(writer);

    let mut conn = Connection::open(&path).unwrap();
    migrate(&mut conn).unwrap();
    let info = preview(&mut conn).unwrap().unwrap();
    assert_eq!(info.action, "mark_bills_paid");
    assert_eq!(info.entry_count, 2);
    assert!(!info.blocked);
    assert_eq!(info.token, token);
    apply(&mut conn, &token).unwrap();
    let rows = snapshot(&mut conn).unwrap().entries;
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|e| e.status == "due"));
    assert!(rows.iter().any(|e| e.id == ids[0] && e.voided));
    assert!(rows.iter().any(|e| e.title == "稍后手记"));
    assert!(preview(&mut conn).unwrap().is_none());
    assert_eq!(apply(&mut conn, &token).unwrap_err().to_string(), STALE);
}

#[test]
fn touching_then_reverting_one_ai_field_blocks_the_entire_batch() {
    let mut conn = database();
    let (_, ids) = entries(&mut conn, 2);
    pay(&conn, &ids);
    let token = preview(&mut conn).unwrap().unwrap().token;
    mark_payment(&conn, &ids[..1], false).unwrap();
    mark_payment(&conn, &ids[..1], true).unwrap();
    assert_eq!(
        preview(&mut conn)
            .unwrap()
            .unwrap()
            .blocked_reason
            .as_deref(),
        Some(CONFLICT)
    );
    assert_eq!(apply(&mut conn, &token).unwrap_err().to_string(), CONFLICT);
    assert!(snapshot(&mut conn)
        .unwrap()
        .entries
        .iter()
        .all(|e| e.status == "paid"));
}

#[test]
fn stale_preview_cannot_consume_new_ticket_or_remove_a_platform_used_by_a_manual_bill() {
    let mut conn = database();
    let (_, ids) = entries(&mut conn, 1);
    pay(&conn, &ids);
    let old = preview(&mut conn).unwrap().unwrap().token;
    let revision = review::revision(&conn).unwrap();
    let platform = add_platform(LedgerWrite::new(&conn, Some(&revision)), "新平台").unwrap();
    let new = preview(&mut conn).unwrap().unwrap();
    assert_eq!(new.platform_count, 1);
    assert_eq!(apply(&mut conn, &old).unwrap_err().to_string(), STALE);
    add_bill(&conn, bill(&platform, "新平台的手记")).unwrap();
    assert_eq!(
        apply(&mut conn, &new.token).unwrap_err().to_string(),
        CONFLICT
    );
    assert_eq!(snapshot(&mut conn).unwrap().entries.len(), 2);
    assert_eq!(preview(&mut conn).unwrap().unwrap().token, new.token);
}

#[test]
fn limited_preview_still_undoes_every_installment_and_rolls_back_on_failure() {
    let mut conn = database();
    let platform = add_platform(&conn, "分期平台").unwrap();
    let mut input = bill(&platform, "逐月分期");
    input.kind = "installment".into();
    input.installment_count = 24;
    let revision = review::revision(&conn).unwrap();
    add_bill(LedgerWrite::new(&conn, Some(&revision)), input).unwrap();
    let ticket = preview(&mut conn).unwrap().unwrap();
    assert_eq!(ticket.items.len(), PREVIEW_LIMIT);
    assert_eq!(ticket.entry_count, 24);
    conn.execute_batch(
        "CREATE TEMP TRIGGER inject_failure BEFORE DELETE ON ai_undo_operation
        BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    )
    .unwrap();
    assert!(apply(&mut conn, &ticket.token)
        .unwrap_err()
        .to_string()
        .contains("test failure"));
    assert_eq!(snapshot(&mut conn).unwrap().entries.len(), 24);
    assert!(!preview(&mut conn).unwrap().unwrap().blocked);
    conn.execute_batch("DROP TRIGGER inject_failure").unwrap();
    apply(&mut conn, &ticket.token).unwrap();
    assert!(snapshot(&mut conn).unwrap().entries.is_empty());
}

#[test]
fn budget_undo_preserves_other_setting_and_other_month() {
    let mut conn = database();
    let original = snapshot(&mut conn).unwrap().settings;
    let revision = review::revision(&conn).unwrap();
    budget(
        LedgerWrite::new(&conn, Some(&revision)),
        BudgetInput {
            month: "2026-11".into(),
            default_salary_cents: 12345,
            warning_floor_cents: original.warning_floor_cents,
            override_salary_cents: Some(67890),
        },
    )
    .unwrap();
    let ticket = preview(&mut conn).unwrap().unwrap();
    assert_eq!(ticket.budget_count, 2);
    budget(
        &conn,
        BudgetInput {
            month: "2026-12".into(),
            default_salary_cents: 12345,
            warning_floor_cents: 54321,
            override_salary_cents: Some(20000),
        },
    )
    .unwrap();
    apply(&mut conn, &ticket.token).unwrap();
    let ledger = snapshot(&mut conn).unwrap();
    assert_eq!(
        ledger.settings.default_salary_cents,
        original.default_salary_cents
    );
    assert_eq!(ledger.settings.warning_floor_cents, 54321);
    assert_eq!(ledger.salary_overrides.len(), 1);
    assert_eq!(ledger.salary_overrides["2026-12"], 20000);
}

#[test]
fn two_undo_windows_can_only_consume_the_ticket_once() {
    use std::{sync::Barrier, thread};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("concurrent.sqlite");
    let mut first = Connection::open(&path).unwrap();
    migrate(&mut first).unwrap();
    let (_, ids) = entries(&mut first, 1);
    pay(&first, &ids);
    let token = preview(&mut first).unwrap().unwrap().token;
    let mut second = Connection::open(&path).unwrap();
    migrate(&mut second).unwrap();
    let together = Barrier::new(2);
    let run = |conn: &mut Connection| {
        together.wait();
        apply(conn, &token).map_err(|e| e.to_string())
    };
    thread::scope(|scope| {
        let one = scope.spawn(|| run(&mut first));
        let two = scope.spawn(|| run(&mut second));
        let results = [one.join().unwrap(), two.join().unwrap()];
        assert!(results.contains(&Ok(())));
        assert!(results.contains(&Err(STALE.to_owned())));
    });
    assert_eq!(snapshot(&mut first).unwrap().entries[0].status, "due");
}

#[test]
fn manual_earlier_installment_in_the_same_series_blocks_deletion() {
    let mut conn = database();
    let platform = add_platform(&conn, "平台").unwrap();
    let mut input = bill(&platform, "分期");
    input.kind = "installment".into();
    input.installment_count = 3;
    input.installment_index = Some(2);
    let revision = review::revision(&conn).unwrap();
    add_bill(LedgerWrite::new(&conn, Some(&revision)), input).unwrap();
    let ticket = preview(&mut conn).unwrap().unwrap();
    assert_eq!(ticket.entry_count, 2);
    conn.execute("INSERT INTO entries(platform_id,title,month,amount_cents,status,kind,
        installment_index,installment_count,installment_id) SELECT platform_id,title,'2026-10',
        amount_cents,status,kind,1,installment_count,installment_id FROM entries WHERE installment_index=2", []).unwrap();
    assert_eq!(
        apply(&mut conn, &ticket.token).unwrap_err().to_string(),
        CONFLICT
    );
    assert_eq!(snapshot(&mut conn).unwrap().entries.len(), 3);
}

#[test]
fn expired_token_is_purged_on_apply_without_changing_ledger() {
    let mut conn = database();
    let (_, ids) = entries(&mut conn, 1);
    pay(&conn, &ids);
    let token = preview(&mut conn).unwrap().unwrap().token;
    conn.execute(
        "UPDATE ai_undo_operation SET local_day=date('now','localtime','-8 days')",
        [],
    )
    .unwrap();
    assert_eq!(apply(&mut conn, &token).unwrap_err().to_string(), STALE);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM ai_undo_change", [], |r| r
            .get::<_, usize>(0))
            .unwrap(),
        0
    );
    assert_eq!(snapshot(&mut conn).unwrap().entries[0].status, "paid");
}

#[test]
fn undoing_paid_confirmation_restores_estimate_and_keeps_manual_void() {
    let mut conn = database();
    let platform = add_platform(&conn, "预付").unwrap();
    let mut original = bill(&platform, "预计尾款");
    original.kind = "estimate".into();
    original.deposit_cents = Some(20);
    add_bill(&conn, original).unwrap();
    let id = snapshot(&mut conn).unwrap().entries.remove(0).id;
    let revision = review::revision(&conn).unwrap();
    confirm(
        LedgerWrite::new(&conn, Some(&revision)),
        ConfirmInput {
            id: id.clone(),
            title: "实际金额".into(),
            month: "2026-12".into(),
            amount_cents: 0,
            deposit_cents: Some(150),
            total_cents: Some(150),
        },
    )
    .unwrap();
    set_entry_voided(&conn, &id, true).unwrap();
    let ticket = preview(&mut conn).unwrap().unwrap();
    assert_eq!(ticket.action, "confirm_estimate");
    apply(&mut conn, &ticket.token).unwrap();
    let entry = snapshot(&mut conn).unwrap().entries.remove(0);
    assert_eq!(entry.id, id);
    assert_eq!(entry.title, "预计尾款");
    assert_eq!(entry.month, "2026-11");
    assert_eq!(entry.status, "estimated");
    assert_eq!((entry.amount_cents, entry.deposit_cents), (100, 20));
    assert!(entry.voided);
}
