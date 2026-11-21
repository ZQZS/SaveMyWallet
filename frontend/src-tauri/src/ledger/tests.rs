use super::*;

mod backup;

fn database() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db).unwrap();
    db
}

fn bill(platform: &str, title: &str, month: &str, amount_cents: i64, kind: &str) -> BillInput {
    BillInput {
        platform_id: platform.to_owned(),
        title: title.to_owned(),
        month: month.to_owned(),
        amount_cents,
        total_cents: None,
        deposit_cents: None,
        kind: kind.to_owned(),
        installment_count: 1,
    }
}

#[test]
fn estimate_deposits_survive_confirmation_and_full_deposits_are_already_settled() {
    let mut db = database();
    let platform = add_platform(&db, "预售").unwrap();
    let mut input = bill(&platform, "预购", "2026-12", 8000, "estimate");
    input.deposit_cents = Some(2000);
    input.total_cents = Some(10000);
    add_bill(&mut db, input).unwrap();
    let original = snapshot(&mut db).unwrap().entries.remove(0);
    assert_eq!(
        (original.amount_cents, original.deposit_cents),
        (8000, 2000)
    );
    // An older caller can still confirm the net amount and preserve the recorded deposit.
    let legacy: ConfirmInput = serde_json::from_value(serde_json::json!({
        "id":original.id, "month":"2027-01", "title":"到货", "amountCents":7000
    }))
    .unwrap();
    confirm(&db, legacy).unwrap();
    let actual = snapshot(&mut db).unwrap().entries.remove(0);
    assert_eq!(
        (
            actual.id,
            actual.status.as_str(),
            actual.amount_cents,
            actual.deposit_cents
        ),
        (original.id, "due", 7000, 2000)
    );

    let mut prepaid = bill(&platform, "全款预订", "2027-02", 0, "estimate");
    prepaid.deposit_cents = Some(10000);
    prepaid.total_cents = Some(10000);
    add_bill(&mut db, prepaid).unwrap();
    let prepaid = snapshot(&mut db).unwrap().entries.pop().unwrap();
    assert_eq!(prepaid.status, "estimated");
    confirm(
        &db,
        ConfirmInput {
            id: prepaid.id.clone(),
            title: prepaid.title,
            month: prepaid.month,
            amount_cents: 0,
            deposit_cents: Some(11000),
            total_cents: Some(11000),
        },
    )
    .unwrap();
    let ids = std::slice::from_ref(&prepaid.id);
    assert!(mark_payment(&mut db, ids, false).unwrap().is_empty());
    assert!(undo_payment(&mut db, ids, false).unwrap().is_empty());
    let settled = snapshot(&mut db).unwrap().entries.pop().unwrap();
    assert_eq!(
        (
            settled.id,
            settled.status.as_str(),
            settled.amount_cents,
            settled.deposit_cents
        ),
        (prepaid.id, "paid", 0, 11000)
    );
}

#[test]
fn invalid_estimate_amounts_are_rejected_without_writing() {
    let mut db = database();
    let platform = add_platform(&db, "预售").unwrap();
    for (net, deposit, total, kind) in [
        (0, 0, 0, "estimate"),
        (-1, 5, 4, "estimate"),
        (100, -1, 99, "estimate"),
        (50, 11, 60, "estimate"),
        (MAX_CENTS, 1, MAX_CENTS + 1, "estimate"),
        (1, i64::MAX, i64::MAX, "estimate"),
        (100, 1, 101, "single"),
        (0, 100, 100, "installment"),
    ] {
        let mut input = bill(&platform, "不应保存", "2026-12", net, kind);
        input.deposit_cents = Some(deposit);
        input.total_cents = Some(total);
        assert!(add_bill(&mut db, input).is_err());
    }
    assert!(snapshot(&mut db).unwrap().entries.is_empty());
    let mut input = bill(&platform, "已付定金", "2026-12", 90, "estimate");
    input.deposit_cents = Some(10);
    add_bill(&mut db, input).unwrap();
    let original = snapshot(&mut db).unwrap().entries.remove(0);
    assert!(confirm(
        &db,
        ConfirmInput {
            id: original.id.clone(),
            title: "不应保存".into(),
            month: "2027-01".into(),
            amount_cents: 70,
            deposit_cents: Some(30),
            total_cents: Some(150),
        }
    )
    .is_err());
    let saved = snapshot(&mut db).unwrap().entries.remove(0);
    assert_eq!(
        serde_json::to_value(saved).unwrap(),
        serde_json::to_value(original).unwrap()
    );
}

#[test]
fn v5_estimates_preserve_row_order_status_and_wire_value_after_migration() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../schema_v1.sql")).unwrap();
    db.execute_batch(include_str!("../initial_data.sql"))
        .unwrap();
    db.execute_batch(include_str!("../schema_v2.sql")).unwrap();
    db.execute_batch(
        "ALTER TABLE sync_queue ADD COLUMN undo_of TEXT;
                      ALTER TABLE sync_queue ADD COLUMN wire_json TEXT;",
    )
    .unwrap();
    db.execute_batch(include_str!("../schema_v3.sql")).unwrap();
    db.execute_batch(include_str!("../schema_v4.sql")).unwrap();
    db.execute_batch(include_str!("../schema_v5.sql")).unwrap();
    db.execute_batch("INSERT INTO entries (rowid,id,platform_id,title,month,amount_cents,kind,status,voided)
        SELECT 28,'legacy',id,'旧补款','2027-01',5000,'estimate','estimated',1 FROM platforms LIMIT 1;").unwrap();
    let wire = |db: &Connection| -> String {
        db.query_row(
            "SELECT value_json FROM sync_local WHERE id='legacy' AND kind='entry'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    let before = wire(&db);
    migrate(&mut db).unwrap();
    migrate(&mut db).unwrap();
    assert_eq!(wire(&db), before);
    let rowid: i64 = db
        .query_row("SELECT rowid FROM entries WHERE id='legacy'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rowid, 28);
    let entry = snapshot(&mut db).unwrap().entries.remove(0);
    assert!(entry.voided);
    assert_eq!(
        (
            entry.status.as_str(),
            entry.amount_cents,
            entry.deposit_cents
        ),
        ("estimated", 5000, 0)
    );
}

#[test]
fn reopening_the_database_preserves_custom_platforms_and_their_bills() {
    let file = std::env::temp_dir().join(format!(
        "savemywallet-test-{}-{}.sqlite3",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut db = Connection::open(&file).unwrap();
    migrate(&mut db).unwrap();
    let initial = snapshot(&mut db).unwrap();
    assert!(initial.entries.is_empty());
    assert_eq!(initial.platforms.len(), 3);
    let id = add_platform(&db, "  我的信用卡  ").unwrap();
    assert!(add_platform(&db, "我的信用卡").is_err());
    assert!(add_platform(&db, "  ").is_err());
    add_bill(&mut db, bill(&id, "本期账单", "2026-12", 12345, "single")).unwrap();
    let entry_id = snapshot(&mut db).unwrap().entries.remove(0).id;
    set_entry_voided(&mut db, &entry_id, true).unwrap();
    drop(db);

    let mut reopened = Connection::open(&file).unwrap();
    migrate(&mut reopened).unwrap();
    let saved = snapshot(&mut reopened).unwrap();
    assert_eq!(saved.platforms.len(), initial.platforms.len() + 1);
    assert!(saved
        .platforms
        .iter()
        .any(|p| p.id == id && p.name == "我的信用卡"));
    assert_eq!(saved.entries.len(), 1);
    assert_eq!(saved.entries[0].platform_id, id);
    assert_eq!(saved.entries[0].amount_cents, 12345);
    assert!(saved.entries[0].voided);
    drop(reopened);
    std::fs::remove_file(file).unwrap();
}

#[test]
fn installments_cross_years_and_invalid_input_leaves_no_entries() {
    let mut db = database();
    let platform = add_platform(&db, "我的分期").unwrap();
    let mut order = bill(&platform, "书架", "2026-12", 10001, "installment");
    order.installment_count = 3;
    add_bill(&mut db, order).unwrap();

    let mut entries = snapshot(&mut db).unwrap().entries;
    entries.sort_by(|a, b| a.month.cmp(&b.month));
    assert_eq!(entries.len(), 3);
    for (i, month) in ["2026-12", "2027-01", "2027-02"].iter().enumerate() {
        assert_eq!(entries[i].month, *month);
        assert_eq!(entries[i].amount_cents, 10001);
        assert_eq!(entries[i].status, "due");
        assert_eq!(entries[i].installment_index.unwrap() as usize, i + 1);
        assert_eq!(entries[i].installment_count, Some(3));
    }
    let mut invalid = bill(&platform, "无效分期", "2026-13", 90, "installment");
    invalid.installment_count = 2;
    assert!(add_bill(&mut db, invalid).is_err());
    assert!(add_bill(
        &mut db,
        bill("missing", "不存在的平台", "2026-12", 90, "single")
    )
    .is_err());
    assert_eq!(snapshot(&mut db).unwrap().entries.len(), 3);
}

#[test]
fn a_failed_installment_rolls_back_the_whole_purchase() {
    let mut db = database();
    let platform = add_platform(&db, "测试分期平台").unwrap();
    db.execute_batch(
        "CREATE TEMP TRIGGER fail_second_installment BEFORE INSERT ON entries
         WHEN NEW.installment_index = 2
         BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;",
    )
    .unwrap();
    let mut order = bill(&platform, "分期", "2026-12", 5000, "installment");
    order.installment_count = 3;
    assert!(add_bill(&mut db, order).is_err());
    assert!(snapshot(&mut db).unwrap().entries.is_empty());
}

#[test]
fn voiding_a_period_preserves_its_status_and_other_periods_and_retries_are_idempotent() {
    let mut db = database();
    let platform = add_platform(&db, "分期").unwrap();
    let mut input = bill(&platform, "月供", "2026-12", 5000, "installment");
    input.installment_count = 2;
    add_bill(&mut db, input).unwrap();
    let ids: Vec<_> = snapshot(&mut db)
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.id)
        .collect();
    let id = ids[0].as_str();
    let wire = |db: &Connection| -> String {
        db.query_row(
            "SELECT value_json FROM sync_local WHERE kind='entry' AND id=?",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    };
    db.execute_batch(
        "INSERT INTO sync_binding VALUES(1,'https://example.invalid','test',1);
        INSERT INTO sync_shadow SELECT kind,id,value_json,'seed',1 FROM sync_local;",
    )
    .unwrap();
    mark_payment(&mut db, &ids, true).unwrap();
    let paid = wire(&db);
    assert!(serde_json::from_str::<serde_json::Value>(&paid)
        .unwrap()
        .get("voided")
        .is_none());
    set_entry_voided(&mut db, id, true).unwrap();
    set_entry_voided(&mut db, id, true).unwrap();
    let rows = snapshot(&mut db).unwrap().entries;
    assert!(rows[0].voided);
    assert_eq!(rows[0].status, "paid");
    assert!(!rows[1].voided);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&wire(&db)).unwrap()["voided"],
        true
    );
    assert!(mark_payment(&mut db, &ids[..1], false).unwrap().is_empty());
    assert_eq!(undo_payment(&mut db, &ids, false).unwrap(), ids[1..]);
    set_entry_voided(&mut db, id, false).unwrap();
    set_entry_voided(&mut db, id, false).unwrap();
    assert_eq!(wire(&db), paid);
    assert!(undo_payment(&mut db, &ids[..1], false).unwrap().is_empty());
    let captures: i32 = db
        .query_row("SELECT count(*) FROM sync_changes WHERE id=?", [id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(captures, 3); // pay, void, restore
    assert_eq!(
        set_entry_voided(&mut db, "missing", true)
            .unwrap_err()
            .to_string(),
        "ENTRY_NOT_FOUND"
    );
}

#[test]
fn estimate_can_be_confirmed_only_after_restoration() {
    let mut db = database();
    let platform = add_platform(&db, "测试预计").unwrap();
    add_bill(&mut db, bill(&platform, "订金", "2026-12", 500, "estimate")).unwrap();
    let id = snapshot(&mut db).unwrap().entries.remove(0).id;
    let confirmation = || ConfirmInput {
        id: id.clone(),
        title: "尾款".into(),
        month: "2027-01".into(),
        amount_cents: 800,
        total_cents: None,
        deposit_cents: None,
    };
    set_entry_voided(&mut db, &id, true).unwrap();
    assert_eq!(
        confirm(&db, confirmation()).unwrap_err().to_string(),
        "STALE_ESTIMATE"
    );
    set_entry_voided(&mut db, &id, false).unwrap();
    assert_eq!(snapshot(&mut db).unwrap().entries[0].status, "estimated");
    confirm(&db, confirmation()).unwrap();
}

fn add_three_period_purchase(db: &mut Connection, platform: &str, start: &str) {
    let mut input = bill(platform, "书架", start, 5000, "installment");
    input.installment_count = 3;
    add_bill(db, input).unwrap();
}

#[test]
fn voiding_a_whole_purchase_across_years_is_atomic_and_isolates_identical_purchases() {
    let mut db = database();
    let platform = add_platform(&db, "书店").unwrap();
    add_three_period_purchase(&mut db, &platform, "2026-12");
    let first = snapshot(&mut db).unwrap().entries;
    let series = first[0].installment_id.as_deref().unwrap();
    assert_eq!(series.len(), 32);
    assert!(series
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert!(first
        .iter()
        .all(|e| e.installment_id.as_deref() == Some(series)));
    let ids: Vec<_> = first.iter().map(|e| e.id.clone()).collect();

    add_three_period_purchase(&mut db, &platform, "2026-12");
    let other = snapshot(&mut db)
        .unwrap()
        .entries
        .into_iter()
        .find(|e| !ids.contains(&e.id))
        .unwrap();
    assert_ne!(other.installment_id.as_deref(), Some(series));
    db.execute_batch(
        "INSERT INTO sync_binding VALUES(1,'https://example.invalid','test',1);
         INSERT INTO sync_shadow SELECT kind,id,value_json,'seed',1 FROM sync_local;",
    )
    .unwrap();
    mark_payment(&mut db, &[ids[0].clone(), other.id.clone()], true).unwrap();
    set_entry_voided(&mut db, &ids[1], true).unwrap();

    // Even an already voided period can identify its whole purchase.
    let changed = set_installment_voided(&mut db, &ids[1], true).unwrap();
    assert_eq!(changed.len(), 2);
    assert!(changed.contains(&ids[0]) && changed.contains(&ids[2]));
    assert!(set_installment_voided(&mut db, &ids[2], true)
        .unwrap()
        .is_empty());
    for entry in snapshot(&mut db).unwrap().entries {
        assert_eq!(entry.voided, ids.contains(&entry.id));
    }
    let operations: i32 = db
        .query_row("SELECT count(*) FROM sync_queue", [], |r| r.get(0))
        .unwrap();
    assert_eq!(operations, 3); // one payment, one period void, one whole-purchase void
    let batch_size: i32 = db
        .query_row(
            "SELECT count(*) FROM sync_changes WHERE operation_id=(
            SELECT operation_id FROM sync_queue ORDER BY seq DESC LIMIT 1)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(batch_size, 2);

    assert_eq!(
        set_installment_voided(&mut db, &ids[2], false)
            .unwrap()
            .len(),
        3
    );
    assert!(set_installment_voided(&mut db, &ids[0], false)
        .unwrap()
        .is_empty());
    for entry in snapshot(&mut db).unwrap().entries {
        assert!(!entry.voided);
        assert_eq!(
            entry.status == "paid",
            entry.id == ids[0] || entry.id == other.id
        );
    }
    assert_eq!(
        undo_payment(&mut db, &[ids[0].clone(), other.id.clone()], false).unwrap(),
        vec![other.id],
    );
}

#[test]
fn a_complete_legacy_schedule_can_be_voided_without_touching_overlapping_purchases() {
    let mut db = database();
    let platform = add_platform(&db, "书店").unwrap();
    add_three_period_purchase(&mut db, &platform, "2026-12");
    let first = snapshot(&mut db).unwrap().entries;
    add_three_period_purchase(&mut db, &platform, "2027-01");
    db.execute("UPDATE entries SET installment_id=NULL", [])
        .unwrap();
    add_three_period_purchase(&mut db, &platform, "2026-12");
    assert_eq!(
        set_installment_voided(&mut db, &first[1].id, true)
            .unwrap()
            .len(),
        3
    );
    for entry in snapshot(&mut db).unwrap().entries {
        assert_eq!(entry.voided, first.iter().any(|e| e.id == entry.id));
    }
    assert_eq!(
        set_installment_voided(&mut db, &first[0].id, false)
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn a_failed_whole_purchase_void_rolls_back_every_period_and_sync_change() {
    let mut db = database();
    let platform = add_platform(&db, "书店").unwrap();
    add_three_period_purchase(&mut db, &platform, "2026-12");
    let first = snapshot(&mut db).unwrap().entries.remove(0);
    db.execute_batch(
        "INSERT INTO sync_binding VALUES(1,'https://example.invalid','test',1);
         INSERT INTO sync_shadow SELECT kind,id,value_json,'seed',1 FROM sync_local;
         CREATE TEMP TRIGGER fail_last_void BEFORE UPDATE OF voided ON entries
         WHEN NEW.installment_index=3 AND NEW.voided=1
         BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;",
    )
    .unwrap();
    assert!(set_installment_voided(&mut db, &first.id, true).is_err());
    assert!(snapshot(&mut db).unwrap().entries.iter().all(|e| !e.voided));
    let pending: i32 = db
        .query_row("SELECT count(*) FROM sync_queue", [], |r| r.get(0))
        .unwrap();
    assert_eq!(pending, 0);
}

#[test]
fn ambiguous_or_incomplete_legacy_schedules_and_inconsistent_series_are_never_voided_together() {
    let mut db = database();
    let platform = add_platform(&db, "书店").unwrap();
    add_three_period_purchase(&mut db, &platform, "2026-12");
    let first = snapshot(&mut db).unwrap().entries;
    let assert_refused = |db: &mut Connection| {
        let error = set_installment_voided(db, &first[0].id, true).unwrap_err();
        assert_eq!(error.to_string(), "INSTALLMENT_GROUP_UNAVAILABLE");
        assert!(snapshot(db).unwrap().entries.iter().all(|e| !e.voided));
    };
    db.execute(
        "UPDATE entries SET title='另一本书' WHERE installment_index=2",
        [],
    )
    .unwrap();
    assert_refused(&mut db);
    db.execute_batch(
        "UPDATE entries SET installment_id=NULL;
         DELETE FROM entries WHERE installment_index=2;",
    )
    .unwrap();
    assert_refused(&mut db);
    add_three_period_purchase(&mut db, &platform, "2026-12");
    db.execute("UPDATE entries SET installment_id=NULL", [])
        .unwrap();
    assert_refused(&mut db);
    set_entry_voided(&mut db, &first[0].id, true).unwrap();
}

#[test]
fn paying_a_platform_skips_estimates_and_undo_only_reverts_changed_items() {
    let mut db = database();
    let platform = add_platform(&db, "平台 A").unwrap();
    for (title, amount, kind) in [
        ("先前已还", 10000, "single"),
        ("这次支付", 20000, "single"),
        ("预估尾款", 6000, "estimate"),
    ] {
        add_bill(&mut db, bill(&platform, title, "2026-12", amount, kind)).unwrap();
    }
    let entries = snapshot(&mut db).unwrap().entries;
    let id = |title: &str| {
        entries
            .iter()
            .find(|e| e.title == title)
            .unwrap()
            .id
            .clone()
    };
    let old = id("先前已还");
    let newly_paid = id("这次支付");
    let estimate = id("预估尾款");
    mark_payment(&mut db, std::slice::from_ref(&old), true).unwrap();
    let group_ids = vec![
        old.clone(),
        newly_paid.clone(),
        estimate.clone(),
        newly_paid.clone(),
    ];
    let changed = mark_payment(&mut db, &group_ids, true).unwrap();
    assert_eq!(changed, vec![newly_paid.clone()]);
    assert!(mark_payment(&mut db, &group_ids, true).unwrap().is_empty());

    add_bill(
        &mut db,
        bill(&platform, "后来补录", "2026-12", 3000, "single"),
    )
    .unwrap();
    let partial = snapshot(&mut db).unwrap();
    assert_eq!(
        partial
            .entries
            .iter()
            .filter(|e| e.status == "paid")
            .count(),
        2
    );
    assert!(partial
        .entries
        .iter()
        .any(|e| e.title == "后来补录" && e.status == "due"));
    assert!(partial
        .entries
        .iter()
        .any(|e| e.id == estimate && e.status == "estimated"));

    assert_eq!(mark_payment(&mut db, &changed, false).unwrap(), changed);
    let undone = snapshot(&mut db).unwrap();
    assert!(undone
        .entries
        .iter()
        .any(|e| e.id == old && e.status == "paid"));
    assert!(undone
        .entries
        .iter()
        .any(|e| e.id == newly_paid && e.status == "due"));

    let confirm_input = || ConfirmInput {
        id: estimate.clone(),
        title: "已核实尾款".to_string(),
        month: "2027-01".to_string(),
        amount_cents: 5500,
        total_cents: None,
        deposit_cents: None,
    };
    confirm(&db, confirm_input()).unwrap();
    assert!(confirm(&db, confirm_input()).is_err());
    let confirmed = snapshot(&mut db).unwrap();
    assert_eq!(confirmed.entries.len(), 4);
    let item = confirmed.entries.iter().find(|e| e.id == estimate).unwrap();
    assert_eq!(item.month, "2027-01");
    assert_eq!(item.amount_cents, 5500);
    assert_eq!(item.status, "due");
}

#[test]
fn replacing_and_clearing_salary_overrides_is_scoped_to_the_selected_month() {
    let mut db = database();
    let input = |month: &str, salary: Option<i64>| BudgetInput {
        month: month.to_owned(),
        default_salary_cents: 800000,
        warning_floor_cents: 150000,
        override_salary_cents: salary,
    };
    budget(&mut db, input("2026-11", Some(750000))).unwrap();
    budget(&mut db, input("2026-12", Some(920000))).unwrap();
    budget(&mut db, input("2026-12", Some(0))).unwrap();
    let zero = snapshot(&mut db).unwrap();
    assert_eq!(zero.salary_overrides.get("2026-12"), Some(&0));

    budget(&mut db, input("2026-12", None)).unwrap();
    let saved = snapshot(&mut db).unwrap();
    assert_eq!(saved.settings.default_salary_cents, 800000);
    assert_eq!(saved.settings.warning_floor_cents, 150000);
    assert_eq!(saved.salary_overrides.len(), 1);
    assert_eq!(saved.salary_overrides.get("2026-11"), Some(&750000));
}
