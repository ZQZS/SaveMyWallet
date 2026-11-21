use super::*;

fn date(value: &str) -> NaiveDate {
    value.parse().unwrap()
}

fn database() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    super::super::migrate(&mut db).unwrap();
    db
}

fn points(db: &mut Connection, value: &str) -> Vec<RestorePoint> {
    let tx = db.transaction().unwrap();
    let points = list_on(&tx, date(value)).unwrap();
    tx.commit().unwrap();
    points
}

fn write_platform(db: &mut Connection, on: &str, name: &str) {
    let tx = db.transaction().unwrap();
    checkpoint_on(&tx, date(on)).unwrap();
    tx.execute("INSERT INTO platforms (name) VALUES (?)", [name])
        .unwrap();
    tx.commit().unwrap();
}

fn apply(db: &mut Connection, on: &str, point: &RestorePoint) -> StorageResult<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    restore_on(&tx, date(on), point.days_ago, &point.date, &point.revision)?;
    Ok(tx.commit()?)
}

#[test]
fn first_day_has_no_past_and_each_slot_selects_exact_end_of_day() {
    let mut db = database();
    let first = points(&mut db, "2028-02-28");
    assert!(first.iter().all(|p| p.preview.is_none()));
    write_platform(&mut db, "2028-02-28", "early");
    write_platform(&mut db, "2028-02-28", "late");
    write_platform(&mut db, "2028-02-29", "new day");

    let leap = points(&mut db, "2028-02-29");
    assert_eq!(leap[0].date, "2028-02-28");
    assert_eq!(leap[0].preview.as_ref().unwrap().platforms, 5);
    assert!(leap[1].preview.is_none());

    // The app was closed for several days. All idle dates share the same end state.
    let week = points(&mut db, "2028-03-06");
    assert_eq!(week[0].date, "2028-03-05");
    assert_eq!(week[0].preview.as_ref().unwrap().platforms, 6);
    assert_eq!(week[1].date, "2028-02-28");
    assert_eq!(week[1].preview.as_ref().unwrap().platforms, 5);
    apply(&mut db, "2028-03-06", &week[1]).unwrap();
    let live = read_ledger(&db).unwrap();
    assert_eq!(live.platforms.len(), 5);
    assert!(live.platforms.iter().any(|p| p.name == "late"));
    let after = points(&mut db, "2028-03-06");
    assert_eq!(after[0].preview.as_ref().unwrap().platforms, 6);
    apply(&mut db, "2028-03-06", &after[0]).unwrap();
    assert_eq!(read_ledger(&db).unwrap().platforms.len(), 6);
}

#[test]
fn unchanged_content_is_shared_pruned_and_never_overwritten_on_clock_rollback() {
    let mut db = database();
    points(&mut db, "2026-11-02");
    for day in 3..=10 {
        points(&mut db, &format!("2026-11-{day:02}"));
    }
    let period = || {
        db.query_row(
            "SELECT MIN(first_day), MAX(last_day), COUNT(*) FROM ledger_history_periods",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u32>(2)?,
                ))
            },
        )
        .unwrap()
    };
    assert_eq!(period(), ("2026-11-03".into(), "2026-11-09".into(), 1));
    write_platform(&mut db, "2026-11-06", "clock correction");
    let early = points(&mut db, "2026-11-08");
    assert_eq!(early[0].preview.as_ref().unwrap().platforms, 3);
    assert!(early[1].preview.is_none());
    let long_gap = points(&mut db, "2027-01-01");
    assert!(long_gap
        .iter()
        .all(|p| p.preview.as_ref().unwrap().platforms == 4));
    assert_eq!(
        db.query_row("SELECT first_day FROM ledger_history_periods", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "2026-12-25"
    );
}

#[test]
fn corrupted_point_is_isolated_and_stale_approvals_leave_live_data_intact() {
    let mut db = database();
    write_platform(&mut db, "2026-11-01", "A");
    write_platform(&mut db, "2026-11-02", "B");
    let before = points(&mut db, "2026-11-08");
    let error = apply(&mut db, "2026-11-09", &before[0]).unwrap_err();
    assert_eq!(error.to_string(), "HISTORY_STALE");
    write_platform(&mut db, "2026-11-08", "C");
    assert_eq!(
        apply(&mut db, "2026-11-08", &before[0])
            .unwrap_err()
            .to_string(),
        "HISTORY_STALE"
    );
    db.execute(
        "UPDATE ledger_history_periods SET contents=X'FF' WHERE first_day='2026-11-01'",
        [],
    )
    .unwrap();
    let candidates = points(&mut db, "2026-11-08");
    assert!(candidates[1].preview.is_none());
    assert_eq!(candidates[0].preview.as_ref().unwrap().platforms, 5);
    assert_eq!(
        apply(&mut db, "2026-11-08", &candidates[1])
            .unwrap_err()
            .to_string(),
        "HISTORY_UNAVAILABLE"
    );
    assert_eq!(read_ledger(&db).unwrap().platforms.len(), 6);

    // Failure after clearing/replacing rows must roll back the entire restore.
    db.execute_batch("CREATE TRIGGER refuse_restore BEFORE INSERT ON platforms BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    let reviewed = points(&mut db, "2026-11-08");
    assert_eq!(
        apply(&mut db, "2026-11-08", &reviewed[0])
            .unwrap_err()
            .to_string(),
        "BACKUP_WRITE"
    );
    assert_eq!(read_ledger(&db).unwrap().platforms.len(), 6);
}

#[test]
fn explicit_reset_discards_prior_history_while_import_preserves_it() {
    let mut db = database();
    let today = Local::now().date_naive();
    let start = days_before(today, 8).unwrap();
    write_platform(&mut db, &start.to_string(), "old");
    assert!(list(&mut db).unwrap().iter().all(|p| p.preview.is_some()));
    let mut fresh = database();
    let contents = backup::export(&mut fresh).unwrap();
    backup::restore(&mut db, &contents).unwrap();
    assert!(list(&mut db)
        .unwrap()
        .iter()
        .all(|p| p.preview.as_ref().unwrap().platforms == 4));
    assert!(backup::reset(&mut db, "").is_err());
    assert!(list(&mut db).unwrap()[0].preview.is_some());
    backup::reset(&mut db, "重置").unwrap();
    assert!(list(&mut db).unwrap().iter().all(|p| p.preview.is_none()));
    assert_eq!(open_day(&db).unwrap(), Some(today.to_string()));
}

#[test]
fn failed_checkpoint_still_expires_all_automatic_copies_after_day_seven() {
    let mut db = database();
    let day = date("2026-11-01");
    observe_on(&mut db, day).unwrap();
    db.execute_batch(
        "INSERT INTO sync_recovery(singleton,contents,created_day) VALUES(1,'old','2026-11-01');
         INSERT INTO ai_undo_operation VALUES(1,'ticket','mark_bills_paid',0,'2026-11-01');
         INSERT INTO ai_undo_change(slot,kind,id,before_json,after_json)
             VALUES(1,'entry','old','null','{}');",
    )
    .unwrap();
    observe_on(&mut db, date("2026-11-02")).unwrap();
    write_platform(&mut db, "2026-11-02", "new");
    observe_on(&mut db, date("2026-11-08")).unwrap();
    let counts =
        |db: &Connection| -> (u32, u32, u32, u32) {
            db.query_row(
            "SELECT (SELECT count(*) FROM sync_recovery), (SELECT count(*) FROM ai_undo_operation),
             (SELECT count(*) FROM ai_undo_change),
             (SELECT count(*) FROM ledger_history_periods WHERE first_day='2026-11-01')",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).unwrap()
        };
    assert_eq!(counts(&db), (1, 1, 1, 1));
    write_platform(&mut db, "2026-11-08", "latest");
    db.execute_batch(
        "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON ledger_history_periods
        BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;",
    )
    .unwrap();
    assert_eq!(
        observe_on(&mut db, date("2026-11-09"))
            .unwrap_err()
            .to_string(),
        CHECKPOINT_ERROR
    );
    assert_eq!(counts(&db), (0, 0, 0, 0));
    assert_eq!(open_day(&db).unwrap().as_deref(), Some("2026-11-08"));
}

#[test]
fn undated_v7_prelink_backup_gets_one_grace_period_and_never_renews_on_restart() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../../schema_v1.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../initial_data.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../schema_v2.sql"))
        .unwrap();
    db.execute_batch(
        "ALTER TABLE sync_queue ADD COLUMN undo_of TEXT;
        ALTER TABLE sync_queue ADD COLUMN wire_json TEXT;",
    )
    .unwrap();
    db.execute_batch(include_str!("../../schema_v3.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../schema_v4.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../schema_v5.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../schema_v6.sql"))
        .unwrap();
    db.execute_batch(include_str!("../../schema_v7.sql"))
        .unwrap();
    db.execute(
        "INSERT INTO sync_recovery (singleton,contents) VALUES(1,'old')",
        [],
    )
    .unwrap();
    super::super::migrate(&mut db).unwrap();
    assert_eq!(sync::status(&db).unwrap()["previousBackupUndated"], true);
    assert_eq!(sync::previous_backup(&db).unwrap().as_deref(), Some("old"));
    let today = Local::now().date_naive();
    let expiry = days_before(today, 7).unwrap().to_string();
    db.execute("UPDATE sync_recovery SET legacy_retention_day=?", [&expiry])
        .unwrap();
    super::super::migrate(&mut db).unwrap();
    observe_on(&mut db, today).unwrap();
    assert!(sync::previous_backup(&db).unwrap().is_some());
    db.execute(
        "UPDATE sync_recovery SET legacy_retention_day=date(legacy_retention_day,'-1 day')",
        [],
    )
    .unwrap();
    assert!(sync::previous_backup(&db).unwrap().is_none());
    assert_eq!(sync::status(&db).unwrap()["hasPreviousBackup"], false);
    observe_on(&mut db, today.succ_opt().unwrap()).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM sync_recovery", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
}

#[test]
fn preview_uses_compact_validated_counts_and_reads_legacy_snapshots() {
    let mut db = database();
    write_platform(&mut db, "2026-11-01", "extra");
    let first = points(&mut db, "2026-11-08");
    assert_eq!(first[1].preview.as_ref().unwrap().platforms, 4);
    let (summary, bytes): (String, usize) = db
        .query_row(
            "SELECT preview_json,length(contents) FROM ledger_history_periods",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(summary.len() < bytes);
    db.execute("UPDATE ledger_history_periods SET preview_json=NULL", [])
        .unwrap();
    let legacy = points(&mut db, "2026-11-08");
    assert!(legacy
        .iter()
        .all(|p| p.preview.as_ref().unwrap().platforms == 4));
}
