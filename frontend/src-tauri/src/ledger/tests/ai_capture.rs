use super::*;
use chrono::NaiveDate;

fn reviewed<'a>(db: &'a Connection, revision: &'a str) -> LedgerWrite<'a> {
    LedgerWrite::new(db, Some(revision))
}

fn header(db: &Connection) -> Option<(String, String)> {
    db.query_row("SELECT token,action FROM ai_undo_operation", [], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()
    .unwrap()
}

fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn captures_only_actual_changes_and_distinguishes_same_field_aba_from_an_unrelated_edit() {
    let mut db = database();
    let platform = add_platform(&db, "测试").unwrap();
    for title in ["已选", "手动"] {
        add_bill(&db, bill(&platform, title, "2026-12", 100, "single")).unwrap();
    }
    let id = snapshot(&mut db).unwrap().entries[0].id.clone();
    let rev = review::revision(&db).unwrap();
    let request = [id.clone(), String::from("nonexistent"), id.clone()];
    assert_eq!(
        mark_payment(reviewed(&db, &rev), &request, true).unwrap(),
        [id.as_str()]
    );
    let ticket = header(&db).unwrap();
    assert_eq!(ticket.1, "mark_bills_paid");
    let (found, old, new, sync): (String, String, String, Option<String>) = db
        .query_row(
            "SELECT id, json_extract(before_json,'$.status'),
                    json_extract(after_json,'$.status'), sync_operation_id FROM ai_undo_change",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (found, old.as_str(), new.as_str(), sync),
        (id.clone(), "due", "paid", None)
    );
    assert_eq!(count(&db, "SELECT count(*) FROM ai_undo_change"), 1);

    let rev = review::revision(&db).unwrap();
    assert!(mark_payment(reviewed(&db, &rev), &request, true)
        .unwrap()
        .is_empty());
    assert_eq!(header(&db), Some(ticket.clone()));
    db.execute(
        "UPDATE entries SET title='用户改名',status=status WHERE id=?",
        [&id],
    )
    .unwrap();
    add_bill(&db, bill(&platform, "新增", "2027-01", 100, "single")).unwrap();
    assert_eq!(count(&db, "SELECT conflicted FROM ai_undo_change"), 0);
    assert_eq!(header(&db), Some(ticket.clone()));

    let rev = review::revision(&db).unwrap();
    let incomplete = [id.clone(), String::from("missing")];
    assert!(set_entries_voided(reviewed(&db, &rev), &incomplete, true).is_err());
    assert_eq!(count(&db, "SELECT sum(voided) FROM entries"), 0);
    assert_eq!(count(&db, "SELECT conflicted FROM ai_undo_change"), 0);
    mark_payment(&db, std::slice::from_ref(&id), false).unwrap();
    mark_payment(&db, std::slice::from_ref(&id), true).unwrap();
    assert_eq!(header(&db), Some(ticket));
    assert_eq!(count(&db, "SELECT conflicted FROM ai_undo_change"), 1);
}

#[test]
fn batch_receipt_covers_each_generated_period_and_tracks_its_own_sync_operation() {
    let db = database();
    let platform = add_platform(&db, "测试").unwrap();
    db.execute(
        "INSERT INTO sync_binding(singleton,url,ledger_id,cursor)
         VALUES(1,'https://example.invalid','fixture',0)",
        [],
    )
    .unwrap();
    let mut split = bill(&platform, "分期", "2027-03", 100, "installment");
    split.installment_count = 5;
    split.installment_index = Some(3);
    let rev = review::revision(&db).unwrap();
    add_bills(
        reviewed(&db, &rev),
        &[split, bill(&platform, "单笔", "2027-03", 50, "single")],
    )
    .unwrap();
    assert_eq!(header(&db).unwrap().1, "create_bill");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM ai_undo_change WHERE kind='entry' AND before_json='null'"
        ),
        4
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(DISTINCT sync_operation_id) FROM ai_undo_change"
        ),
        2
    );
    let matched = count(
        &db,
        "SELECT count(*) FROM ai_undo_change c JOIN sync_changes s
         ON s.operation_id=c.sync_operation_id AND s.id=c.id AND s.kind=c.kind",
    );
    assert_eq!(matched, 4);
    db.execute("UPDATE entries SET title='新名' WHERE title='单笔'", [])
        .unwrap();
    assert_eq!(count(&db, "SELECT sum(conflicted) FROM ai_undo_change"), 1);
}

#[test]
fn budget_keeps_only_changed_keys_and_receipt_failure_rolls_back_the_business_write() {
    let db = database();
    let input = |salary, floor, monthly| BudgetInput {
        month: "2027-01".into(),
        default_salary_cents: salary,
        warning_floor_cents: floor,
        override_salary_cents: monthly,
    };
    budget(&db, input(100, 30, Some(120))).unwrap();
    let rev = review::revision(&db).unwrap();
    budget(reviewed(&db, &rev), input(150, 30, None)).unwrap();
    assert_eq!(count(&db, "SELECT count(*) FROM ai_undo_change"), 2);
    let matched = count(
        &db,
        "SELECT count(*) FROM ai_undo_change WHERE
             (kind='setting' AND id='defaultSalaryCents' AND before_json='100' AND after_json='150')
          OR (kind='override' AND id='2027-01' AND before_json='120' AND after_json='null')",
    );
    assert_eq!(matched, 2);
    let ticket = header(&db);
    db.execute_batch(
        "CREATE TRIGGER break_capture BEFORE INSERT ON ai_undo_change
                      BEGIN SELECT RAISE(ABORT,'disk write failure'); END;",
    )
    .unwrap();
    let rev = review::revision(&db).unwrap();
    assert!(budget(reviewed(&db, &rev), input(200, 30, None)).is_err());
    assert_eq!(count(&db, "SELECT default_salary_cents FROM settings"), 150);
    assert_eq!(count(&db, "SELECT sum(conflicted) FROM ai_undo_change"), 0);
    assert_eq!(header(&db), ticket);
}

#[test]
fn receipts_expire_after_the_seventh_local_date_and_full_replacements_discard_them() {
    let mut db = database();
    let rev = review::revision(&db).unwrap();
    add_platform(reviewed(&db, &rev), "测试").unwrap();
    db.execute("UPDATE ai_undo_operation SET local_day='2028-02-25'", [])
        .unwrap();
    ai_undo_capture::expire(&db, NaiveDate::from_ymd_opt(2028, 3, 3).unwrap()).unwrap();
    assert!(header(&db).is_some());
    ai_undo_capture::expire(&db, NaiveDate::from_ymd_opt(2028, 3, 4).unwrap()).unwrap();
    assert!(header(&db).is_none());
    assert_eq!(count(&db, "SELECT count(*) FROM ai_undo_change"), 0);
    let rev = review::revision(&db).unwrap();
    add_platform(reviewed(&db, &rev), "另一个").unwrap();
    let backup = crate::ledger::backup::export(&mut db).unwrap();
    crate::ledger::backup::restore(&mut db, &backup).unwrap();
    assert!(header(&db).is_none());
    let rev = review::revision(&db).unwrap();
    add_platform(reviewed(&db, &rev), "重置前").unwrap();
    crate::ledger::backup::reset(&mut db, "重置").unwrap();
    assert!(header(&db).is_none());
    assert_eq!(count(&db, "SELECT count(*) FROM ai_undo_change"), 0);
}
