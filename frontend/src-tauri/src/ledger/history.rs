use super::{backup, read_ledger, review, sync, Ledger, StorageResult};
use chrono::{Days, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

const WINDOW: u64 = 7;
const CHECKPOINT_ERROR: &str = "HISTORY_CHECKPOINT";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestorePoint {
    pub(crate) days_ago: u8,
    pub(crate) date: String,
    pub(crate) preview: Option<backup::BackupPreview>,
    pub(crate) revision: String,
}

fn open_day(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT open_day FROM ledger_history_clock WHERE id=1",
        [],
        |row| row.get(0),
    )
    .optional()
}

fn days_before(today: NaiveDate, count: u64) -> StorageResult<NaiveDate> {
    today
        .checked_sub_days(Days::new(count))
        .ok_or_else(|| "HISTORY_UNAVAILABLE".into())
}

pub(super) fn retention_start(today: NaiveDate) -> StorageResult<String> {
    Ok(days_before(today, WINDOW)?.to_string())
}

fn prune(tx: &Transaction<'_>, today: NaiveDate) -> StorageResult<()> {
    let oldest = retention_start(today)?;
    tx.execute(
        "DELETE FROM ledger_history_periods WHERE last_day < ?",
        [&oldest],
    )?;
    tx.execute(
        "UPDATE ledger_history_periods SET first_day=?1 WHERE first_day < ?1",
        [&oldest],
    )?;
    tx.execute(
        "DELETE FROM sync_recovery WHERE coalesce(created_day, legacy_retention_day) < ?",
        [&oldest],
    )?;
    super::ai_undo_capture::expire(tx, today)?;
    Ok(())
}

fn rollover(tx: &Transaction<'_>, today: NaiveDate) -> StorageResult<()> {
    let date = today.to_string();
    let open = open_day(tx)?;
    if open.as_ref() == Some(&date) {
        return Ok(());
    }
    prune(tx, today)?;
    let Some(open) = open else {
        // The device had no coverage before this date, including on first upgrade.
        tx.execute(
            "INSERT INTO ledger_history_clock (id, open_day) VALUES (1, ?)",
            [&date],
        )?;
        return Ok(());
    };
    if open > date {
        // A clock change can revisit a closed date. Keep its snapshot intact, but
        // continue expiring copies created while the clock is catching up.
        return Ok(());
    }
    let last = days_before(today, 1)?;
    // No ledger write occurred between open and yesterday. One document covers all of them.
    let first = open.max(retention_start(today)?);
    let ledger = read_ledger(tx)?;
    let summary = backup::validate(&ledger)
        .ok()
        .map(|()| backup::summarize(&ledger));
    let preview = serde_json::to_string(&summary)?;
    let contents = backup::encode_contents(ledger)?;
    let merged = tx.execute(
        "UPDATE ledger_history_periods SET last_day=?1, preview_json=?4
         WHERE last_day=date(?2,'-1 day') AND contents=?3",
        params![last.to_string(), first, contents, preview],
    )?;
    if merged == 0 {
        tx.execute(
            "INSERT INTO ledger_history_periods (first_day, last_day, contents, preview_json) VALUES (?,?,?,?)",
            params![first, last.to_string(), contents, preview],
        )?;
    }
    tx.execute(
        "UPDATE ledger_history_clock SET open_day=? WHERE id=1",
        [&date],
    )?;
    Ok(())
}

pub(super) fn checkpoint_on(tx: &Transaction<'_>, today: NaiveDate) -> StorageResult<()> {
    rollover(tx, today).map_err(|_| CHECKPOINT_ERROR.into())
}

pub(super) fn checkpoint(tx: &Transaction<'_>) -> StorageResult<()> {
    checkpoint_on(tx, Local::now().date_naive())
}

pub(crate) fn observe(conn: &mut Connection) -> StorageResult<()> {
    observe_on(conn, Local::now().date_naive())
}

fn observe_on(conn: &mut Connection, today: NaiveDate) -> StorageResult<()> {
    // The common read path never takes the writer lock or invalidates an AI review.
    let date = today.to_string();
    if open_day(conn)
        .map_err(|_| CHECKPOINT_ERROR)?
        .is_some_and(|open| open == date)
    {
        return Ok(());
    }
    let archive = (|| -> StorageResult<()> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        checkpoint_on(&tx, today)?;
        Ok(tx.commit()?)
    })();
    if archive.is_ok() {
        return Ok(());
    }
    // A failed new snapshot must not prolong the lifetime of old copies.
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| CHECKPOINT_ERROR)?;
    prune(&tx, today).map_err(|_| CHECKPOINT_ERROR)?;
    tx.commit().map_err(|_| CHECKPOINT_ERROR)?;
    Err(CHECKPOINT_ERROR.into())
}

pub(super) fn reset_tracking(tx: &Transaction<'_>) -> StorageResult<()> {
    tx.execute("DELETE FROM ledger_history_periods", [])
        .map_err(|_| "BACKUP_WRITE")?;
    tx.execute("DELETE FROM ledger_history_clock", [])
        .map_err(|_| "BACKUP_WRITE")?;
    checkpoint(tx)
}

fn ledger_at(conn: &Connection, date: &str) -> StorageResult<Option<Ledger>> {
    let record = conn
        .query_row(
            "SELECT contents FROM ledger_history_periods WHERE first_day <= ?1 AND last_day >= ?1",
            [date],
            |row| {
                // Isolate a damaged backup from the other restore point and the live ledger.
                Ok(row
                    .get_ref(0)?
                    .as_str()
                    .ok()
                    .and_then(|text| backup::decode_contents(text).ok()))
            },
        )
        .optional()
        .map_err(|_| "BACKUP_READ")?;
    Ok(record.flatten())
}

fn preview_at(conn: &Connection, date: &str) -> StorageResult<Option<backup::BackupPreview>> {
    let summary: Option<Option<String>> = conn
        .query_row(
            "SELECT preview_json FROM ledger_history_periods INDEXED BY ledger_history_preview
             WHERE first_day <= ?1 AND last_day >= ?1",
            [date],
            |row| row.get(0),
        )
        .optional()?;
    let Some(summary) = summary else {
        return Ok(None);
    };
    if let Some(preview) = summary.and_then(|text| serde_json::from_str(&text).ok()) {
        return Ok(preview);
    }
    // Version 7 snapshots and externally changed copies need a full validation.
    Ok(ledger_at(conn, date)?.as_ref().map(backup::summarize))
}

fn list_on(tx: &Transaction<'_>, today: NaiveDate) -> StorageResult<Vec<RestorePoint>> {
    checkpoint_on(tx, today)?;
    let revision = review::revision(tx).map_err(|_| "BACKUP_READ")?;
    [1, 7]
        .into_iter()
        .map(|days_ago| {
            let date = days_before(today, days_ago.into())?.to_string();
            let preview = preview_at(tx, &date)?;
            Ok(RestorePoint {
                days_ago,
                date,
                preview,
                revision: revision.clone(),
            })
        })
        .collect()
}

pub(crate) fn list(conn: &mut Connection) -> StorageResult<Vec<RestorePoint>> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "BACKUP_READ")?;
    let points = list_on(&tx, Local::now().date_naive())?;
    tx.commit().map_err(|_| CHECKPOINT_ERROR)?;
    Ok(points)
}

fn restore_on(
    tx: &Transaction<'_>,
    today: NaiveDate,
    days_ago: u8,
    date: &str,
    revision: &str,
) -> StorageResult<()> {
    sync::require_unbound(tx)?;
    if !matches!(days_ago, 1 | 7) {
        return Err("HISTORY_UNAVAILABLE".into());
    }
    if days_before(today, days_ago.into())?.to_string() != date {
        return Err("HISTORY_STALE".into());
    }
    checkpoint_on(tx, today)?;
    if review::revision(tx).map_err(|_| "BACKUP_READ")? != revision {
        return Err("HISTORY_STALE".into());
    }
    let ledger = ledger_at(tx, date)?.ok_or("HISTORY_UNAVAILABLE")?;
    backup::replace(tx, ledger).map_err(|_| "BACKUP_WRITE")?;
    Ok(())
}

pub(crate) fn restore(
    conn: &mut Connection,
    days_ago: u8,
    date: &str,
    revision: &str,
) -> StorageResult<()> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "BACKUP_WRITE")?;
    restore_on(&tx, Local::now().date_naive(), days_ago, date, revision)?;
    Ok(tx.commit().map_err(|_| "BACKUP_WRITE")?)
}

#[cfg(test)]
mod tests;
