use super::{ledger, Database};
use chrono::Local;
use std::{path::Path, sync::Mutex};

fn open(directory: &Path) -> Database {
    Database {
        directory: directory.to_owned(),
        connection: Mutex::new(None),
    }
}

// Arrange an overnight gap without changing the device clock.
fn end_yesterday(db: &Database) {
    let yesterday = Local::now().date_naive().pred_opt().unwrap().to_string();
    db.access(|conn| {
        assert_eq!(
            conn.execute(
                "UPDATE ledger_history_clock SET open_day=?1 WHERE id=1",
                [yesterday]
            )?,
            1
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn first_write_after_reopen_preserves_the_preceding_days_ledger() {
    let directory = tempfile::tempdir().unwrap();
    let db = open(directory.path());
    db.access_checked(None, |write| ledger::add_platform(write, "昨日保存的平台"))
        .unwrap();
    let yesterday = db.access(ledger::backup::export).unwrap();
    end_yesterday(&db);
    drop(db);

    let db = open(directory.path());
    db.access_checked(None, |write| ledger::add_platform(write, "今日新增的平台"))
        .unwrap();
    let points = db.access(ledger::history::list).unwrap();
    let point = points.iter().find(|point| point.days_ago == 1).unwrap();
    assert!(point.preview.is_some());
    db.access(|conn| ledger::history::restore(conn, point.days_ago, &point.date, &point.revision))
        .unwrap();
    assert_eq!(db.access(ledger::backup::export).unwrap(), yesterday);
}

#[test]
fn checkpoint_write_failure_keeps_the_live_ledger_readable_but_blocks_business_writes() {
    let directory = tempfile::tempdir().unwrap();
    let db = open(directory.path());
    let baseline = db.access(ledger::backup::export).unwrap();
    db.access(|conn| {
        Ok(conn.execute_batch(
            "CREATE TRIGGER fail_history_write BEFORE INSERT ON ledger_history_periods
             BEGIN SELECT RAISE(ABORT, 'simulated checkpoint failure'); END;",
        )?)
    })
    .unwrap();
    end_yesterday(&db);

    assert_eq!(db.access(ledger::backup::export).unwrap(), baseline);
    assert_eq!(
        db.access(ledger::history::list).err().as_deref(),
        Some("HISTORY_CHECKPOINT")
    );
    assert_eq!(
        db.access_checked(None, |write| ledger::add_platform(write, "不能提前写入"))
            .unwrap_err(),
        "HISTORY_CHECKPOINT"
    );
    assert_eq!(db.access(ledger::backup::export).unwrap(), baseline);

    db.access(|conn| Ok(conn.execute_batch("DROP TRIGGER fail_history_write")?))
        .unwrap();
    db.access_checked(None, |write| ledger::add_platform(write, "重试成功"))
        .unwrap();
    assert!(db.access(ledger::history::list).unwrap()[0]
        .preview
        .is_some());
}
