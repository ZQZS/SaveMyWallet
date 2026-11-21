use super::{
    add_bill, add_platform, bill, budget, confirm, database, mark_payment, snapshot, BudgetInput,
    ConfirmInput, Connection,
};
use crate::ledger::backup::{export, preview, reset, restore};
use serde_json::{json, Value};

fn sample_ledger() -> Connection {
    let mut db = database();
    let platform = add_platform(&db, "示例平台").unwrap();
    let mut installment = bill(&platform, "六角扳手套装", "2026-12", 3250, "installment");
    installment.installment_count = 2;
    add_bill(&mut db, installment).unwrap();
    add_bill(
        &mut db,
        bill(&platform, "画册尾款", "2026-12", 7688, "estimate"),
    )
    .unwrap();
    add_bill(
        &mut db,
        bill(&platform, "待定补款", "2027-03", 600, "estimate"),
    )
    .unwrap();
    let entries = snapshot(&mut db).unwrap().entries;
    let first = entries
        .iter()
        .find(|e| e.installment_index == Some(1))
        .unwrap();
    mark_payment(&mut db, std::slice::from_ref(&first.id), true).unwrap();
    let estimate = entries.iter().find(|e| e.title == "画册尾款").unwrap();
    confirm(
        &db,
        ConfirmInput {
            id: estimate.id.clone(),
            title: "已确认尾款".to_owned(),
            month: "2027-01".to_owned(),
            amount_cents: 7700,
            deposit_cents: None,
            total_cents: None,
        },
    )
    .unwrap();
    budget(
        &mut db,
        BudgetInput {
            month: "2027-01".into(),
            default_salary_cents: 960000,
            warning_floor_cents: 320000,
            override_salary_cents: Some(0),
        },
    )
    .unwrap();
    db
}

fn snapshot_json(db: &mut Connection) -> Value {
    serde_json::to_value(snapshot(db).unwrap()).unwrap()
}

#[test]
fn v4_preserves_estimate_deposits_and_refuses_invalid_totals_or_downgrades() {
    let mut source = database();
    let platform = add_platform(&source, "预售").unwrap();
    let mut input = bill(&platform, "全额定金", "2027-01", 0, "estimate");
    input.total_cents = Some(32000);
    input.deposit_cents = Some(32000);
    add_bill(&mut source, input).unwrap();
    let saved = export(&mut source).unwrap();
    let backup: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(backup["version"], 4);
    let entry = &backup["ledger"]["entries"][0];
    assert_eq!(entry["depositCents"], 32000);
    assert_eq!(entry["amountCents"], 0);
    let mut target = sample_ledger();
    restore(&mut target, &saved).unwrap();
    let original = snapshot_json(&mut target);
    assert_eq!(original, snapshot_json(&mut source));
    for (pointer, value) in [
        ("/version", json!(3)),
        ("/ledger/entries/0/depositCents", Value::Null),
        ("/ledger/entries/0/depositCents", json!(-1)),
        ("/ledger/entries/0/depositCents", json!(0)),
        ("/ledger/entries/0/amountCents", json!(99_999_999_900_i64)),
        ("/ledger/entries/0/status", json!("due")),
    ] {
        let mut invalid = backup.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(restore(&mut target, &invalid.to_string()).is_err());
        assert_eq!(snapshot_json(&mut target), original);
    }
}

#[test]
fn backup_round_trips_ids_order_states_and_zero_salary_override() {
    let mut source = sample_ledger();
    let original = snapshot_json(&mut source);
    let contents = export(&mut source).unwrap();
    let backup: Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(backup["format"], "SaveMyWallet");
    assert_eq!(backup["version"], 3);
    let installments: Vec<_> = original["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "installment")
        .collect();
    assert!(installments[0]["installmentId"].is_string());
    assert_eq!(
        installments[0]["installmentId"],
        installments[1]["installmentId"]
    );
    assert_eq!(backup["ledger"], original);
    let info = preview(&contents).unwrap();
    assert_eq!((info.platforms, info.entries, info.overrides), (4, 4, 1));

    let mut target = database();
    let old_id = add_platform(&target, "旧账本").unwrap();
    add_bill(
        &mut target,
        bill(&old_id, "旧款项", "2025-12", 99, "single"),
    )
    .unwrap();

    restore(&mut target, &contents).unwrap();
    assert_eq!(snapshot_json(&mut target), original);
    restore(&mut target, &contents).unwrap();
    assert_eq!(snapshot_json(&mut target), original);
    let member_id = installments[1]["id"].as_str().unwrap();
    let changed = crate::ledger::set_installment_voided(&mut target, member_id, true).unwrap();
    assert_eq!(changed.len(), 2);
    let voided = export(&mut target).unwrap();
    restore(&mut target, &voided).unwrap();
    let changed = crate::ledger::set_installment_voided(&mut target, member_id, false).unwrap();
    assert_eq!(changed.len(), 2);
    assert_eq!(snapshot_json(&mut target), original);
}

#[test]
fn restored_installment_tail_keeps_its_periods_and_can_be_voided_individually() {
    let mut source = database();
    let platform = add_platform(&source, "书店").unwrap();
    let mut input = bill(&platform, "画册月供", "2026-12", 6900, "installment");
    input.installment_index = Some(3);
    input.installment_count = 4;
    add_bill(&mut source, input).unwrap();

    let saved = export(&mut source).unwrap();
    assert_eq!(preview(&saved).unwrap().entries, 2);
    let mut target = database();
    restore(&mut target, &saved).unwrap();
    assert_eq!(snapshot_json(&mut target), snapshot_json(&mut source));
    let periods = snapshot(&mut target).unwrap().entries;
    assert_eq!(periods[0].installment_index, Some(3));
    assert_eq!(periods[1].installment_index, Some(4));
    assert!(periods[0].installment_id.is_some());
    assert_eq!(periods[0].installment_id, periods[1].installment_id);

    let error =
        crate::ledger::set_installment_voided(&mut target, &periods[0].id, true).unwrap_err();
    assert_eq!(error.to_string(), "INSTALLMENT_GROUP_UNAVAILABLE");
    assert!(snapshot(&mut target)
        .unwrap()
        .entries
        .iter()
        .all(|entry| !entry.voided));
    crate::ledger::set_entry_voided(&mut target, &periods[0].id, true).unwrap();
    let updated = snapshot(&mut target).unwrap().entries;
    assert!(updated[0].voided);
    assert!(!updated[1].voided);
}

#[test]
fn backup_preserves_voided_installment_and_payment_state() {
    let mut source = sample_ledger();
    // Older v1/v2 backups contain installment numbers but no group identifier.
    source
        .execute("UPDATE entries SET installment_id=NULL", [])
        .unwrap();
    let old = export(&mut source).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&old).unwrap()["version"], 1);
    let mut target = database();
    restore(&mut target, &old).unwrap();
    assert_eq!(snapshot_json(&mut target), snapshot_json(&mut source));
    let paid = snapshot(&mut source)
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.status == "paid")
        .unwrap();
    crate::ledger::set_entry_voided(&mut source, &paid.id, true).unwrap();
    let original = snapshot_json(&mut source);
    let contents = export(&mut source).unwrap();
    let mut backup: Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(backup["version"], 2);
    restore(&mut target, &contents).unwrap();
    assert_eq!(snapshot_json(&mut target), original);
    crate::ledger::set_entry_voided(&mut target, &paid.id, false).unwrap();
    let restored = snapshot(&mut target)
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.id == paid.id)
        .unwrap();
    assert!(!restored.voided);
    assert_eq!(restored.status, "paid");
    assert_eq!(restored.installment_index, paid.installment_index);
    // The v1 format has no way to describe a voided entry.
    backup["version"] = json!(1);
    assert_eq!(
        preview(&backup.to_string()).err().unwrap().to_string(),
        "BACKUP_INVALID"
    );
}

#[test]
fn invalid_backups_are_rejected_by_preview_and_restore_without_changes() {
    let mut db = sample_ledger();
    let original = snapshot_json(&mut db);
    let backup: Value = serde_json::from_str(&export(&mut db).unwrap()).unwrap();
    let duplicate_id = backup["ledger"]["entries"][1]["id"].clone();
    let duplicate_platform = backup["ledger"]["platforms"][1]["name"].clone();
    let mut fixtures = vec![("{".to_owned(), "BACKUP_FORMAT")];
    for (pointer, value, error) in [
        ("/format", json!("OtherApp"), "BACKUP_FORMAT"),
        ("/version", json!(5), "BACKUP_VERSION"),
        ("/version", json!(2), "BACKUP_INVALID"),
        (
            "/ledger/entries/0/installmentId",
            json!("not-a-series-id"),
            "BACKUP_INVALID",
        ),
        (
            "/ledger/entries/0/installmentId",
            Value::Null,
            "BACKUP_INVALID",
        ),
        (
            "/ledger/entries/0/platformId",
            json!("missing"),
            "BACKUP_INVALID",
        ),
        ("/ledger/entries/0/id", duplicate_id, "BACKUP_INVALID"),
        (
            "/ledger/platforms/0/name",
            duplicate_platform,
            "BACKUP_INVALID",
        ),
        (
            "/ledger/entries/0/month",
            json!("2027-13"),
            "BACKUP_INVALID",
        ),
        (
            "/ledger/entries/0/installmentIndex",
            json!(0),
            "BACKUP_INVALID",
        ),
        (
            "/ledger/entries/0/status",
            json!("estimated"),
            "BACKUP_INVALID",
        ),
        ("/ledger/entries/0/amountCents", json!(-1), "BACKUP_INVALID"),
        (
            "/ledger/settings/defaultSalaryCents",
            json!(1.5),
            "BACKUP_INVALID",
        ),
        (
            "/ledger/salaryOverrides",
            json!({"2027-13": 0}),
            "BACKUP_INVALID",
        ),
    ] {
        let mut invalid = backup.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        fixtures.push((invalid.to_string(), error));
    }
    let mut duplicate = backup.clone();
    let mut period = duplicate["ledger"]["entries"][0].clone();
    period["id"] = json!("duplicate-period");
    duplicate["ledger"]["entries"]
        .as_array_mut()
        .unwrap()
        .push(period);
    fixtures.push((duplicate.to_string(), "BACKUP_INVALID"));
    let mut inconsistent = backup.clone();
    let other_period = inconsistent["ledger"]["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["installmentIndex"] == 2)
        .unwrap();
    other_period["amountCents"] = json!(100);
    fixtures.push((inconsistent.to_string(), "BACKUP_INVALID"));
    for (contents, code) in fixtures {
        assert_eq!(
            preview(&contents)
                .err()
                .expect("invalid preview")
                .to_string(),
            code
        );
        assert_eq!(restore(&mut db, &contents).unwrap_err().to_string(), code);
        assert_eq!(snapshot_json(&mut db), original);
    }
}

#[test]
fn failed_insert_during_restore_rolls_back_replaced_data() {
    let contents = export(&mut sample_ledger()).unwrap();
    let mut db = database();
    let platform = add_platform(&db, "当前平台").unwrap();
    add_bill(
        &mut db,
        bill(&platform, "当前账单", "2026-10", 5050, "single"),
    )
    .unwrap();
    let before = snapshot_json(&mut db);
    db.execute_batch(
        "CREATE TEMP TRIGGER fail_restore BEFORE INSERT ON entries
         WHEN NEW.installment_index = 2
         BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
    )
    .unwrap();

    assert!(restore(&mut db, &contents).is_err());
    assert_eq!(snapshot_json(&mut db), before);
}

#[test]
fn reset_requires_exact_confirmation_and_restores_initial_defaults() {
    let mut db = sample_ledger();
    let before = snapshot_json(&mut db);
    for rejected in ["", "RESET", "重", " 重置", "重置 ", "重置\n", "重設"] {
        assert_eq!(
            reset(&mut db, rejected).unwrap_err().to_string(),
            "RESET_CONFIRMATION"
        );
        assert_eq!(snapshot_json(&mut db), before);
    }

    reset(&mut db, "重置").unwrap();
    let cleared = snapshot(&mut db).unwrap();
    let initial = snapshot(&mut database()).unwrap();
    let names: Vec<_> = cleared.platforms.iter().map(|p| &p.name).collect();
    let initial_names: Vec<_> = initial.platforms.iter().map(|p| &p.name).collect();
    assert_eq!(names, initial_names);
    assert!(cleared.entries.is_empty());
    assert!(cleared.salary_overrides.is_empty());
    assert_eq!(cleared.settings.default_salary_cents, 0);
    assert_eq!(cleared.settings.warning_floor_cents, 0);
}

#[test]
fn a_failed_reset_keeps_bills_and_custom_platforms() {
    let mut db = sample_ledger();
    let before = snapshot_json(&mut db);
    db.execute_batch(
        "CREATE TEMP TRIGGER fail_reset BEFORE DELETE ON platforms
         WHEN OLD.name = '示例平台'
         BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
    )
    .unwrap();
    assert!(reset(&mut db, "重置").is_err());
    assert_eq!(snapshot_json(&mut db), before);
}
