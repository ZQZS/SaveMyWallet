//! Each local business transaction captures its actual rows in the durable queue.
//! Local ledger tables are the visible working copy; shadow rows are server state.
use super::{backup, read_ledger, StorageResult};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

mod reconcile;
mod records;
#[cfg(test)]
mod tests;

#[derive(Clone, Deserialize, Serialize)]
struct Record {
    kind: String,
    id: String,
    value: Value,
    version: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    kind: String,
    id: String,
    base_version: Option<String>,
    before: Value,
    after: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    operation_id: String,
    seed: bool,
    changes: Vec<Change>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    ledger_id: String,
    cursor: i64,
    records: Vec<Record>,
}

pub(super) fn bound(conn: &Connection) -> StorageResult<bool> {
    Ok(
        conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_binding)", [], |r| {
            r.get(0)
        })?,
    )
}

pub(super) fn require_unbound(conn: &Connection) -> StorageResult<()> {
    if bound(conn)? {
        return Err("SYNC_BOUND".into());
    }
    Ok(())
}

fn ledger_cursor(conn: &Connection) -> StorageResult<(String, i64)> {
    conn.query_row("SELECT ledger_id,cursor FROM sync_binding", [], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()?
    .ok_or_else(|| "SYNC_NOT_BOUND".into())
}

fn fresh_id(conn: &Connection) -> StorageResult<String> {
    Ok(conn.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?)
}

fn new_queue_row(conn: &Connection, seed: bool) -> StorageResult<String> {
    let id = fresh_id(conn)?;
    conn.execute(
        "INSERT INTO sync_queue(operation_id,seed) VALUES (?,?)",
        params![id, seed],
    )?;
    Ok(id)
}

fn store_change(conn: &Connection, operation: &str, change: &Change) -> StorageResult<()> {
    conn.execute(
        "INSERT INTO sync_changes(operation_id,kind,id,base_version,before_json,after_json)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(operation_id,kind,id) DO UPDATE SET base_version=excluded.base_version,
         before_json=excluded.before_json,after_json=excluded.after_json",
        params![
            operation,
            change.kind,
            change.id,
            change.base_version,
            change.before.to_string(),
            change.after.to_string()
        ],
    )?;
    Ok(())
}

fn decode_json(text: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn read_change(row: &rusqlite::Row<'_>) -> rusqlite::Result<Change> {
    Ok(Change {
        kind: row.get(0)?,
        id: row.get(1)?,
        base_version: row.get(2)?,
        before: decode_json(row.get(3)?)?,
        after: decode_json(row.get(4)?)?,
    })
}

fn operation(conn: &Connection, id: &str) -> StorageResult<Operation> {
    let seed = conn.query_row(
        "SELECT seed FROM sync_queue WHERE operation_id=?",
        [id],
        |r| r.get(0),
    )?;
    let mut query = conn.prepare(
        "SELECT kind,id,base_version,before_json,after_json FROM sync_changes
         WHERE operation_id=? ORDER BY CASE kind WHEN 'platform' THEN 0 ELSE 1 END,kind,id",
    )?;
    let changes = query
        .query_map([id], read_change)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Operation {
        operation_id: id.to_owned(),
        seed,
        changes,
    })
}

// Capture only the keys actually addressed by this write. For a locally chained
// mutation, its predecessor is the prior queued operation on the same key.
pub(super) fn capture<'a>(
    tx: &Transaction<'_>,
    keys: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> StorageResult<Option<String>> {
    if !bound(tx)? {
        return Ok(None);
    }
    let mut op = None;
    for (kind, id) in keys {
        let previous: Option<(Option<String>,String)> = tx.query_row(
            "SELECT c.operation_id,c.after_json FROM sync_changes c JOIN sync_queue q USING(operation_id)
             WHERE c.kind=? AND c.id=? ORDER BY q.seq DESC LIMIT 1", [kind,id],
            |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let (base_version, before_json) = match previous {
            Some(previous) => previous,
            None => tx
                .query_row(
                    "SELECT version,value_json FROM sync_shadow WHERE kind=? AND id=?",
                    [kind, id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .unwrap_or((None, "null".into())),
        };
        let before = decode_json(before_json)?;
        let after = tx
            .query_row(
                "SELECT value_json FROM sync_local WHERE kind=? AND id=?",
                [kind, id],
                |r| decode_json(r.get(0)?),
            )
            .optional()?
            .unwrap_or(Value::Null);
        if before == after {
            continue;
        }
        if op.is_none() {
            op = Some(new_queue_row(tx, false)?);
        }
        store_change(
            tx,
            op.as_deref().unwrap(),
            &Change {
                kind: kind.to_owned(),
                id: id.to_owned(),
                base_version,
                before,
                after,
            },
        )?;
    }
    Ok(op)
}

fn remember(conn: &Connection, record: &Record, cursor: i64) -> StorageResult<bool> {
    if record.id.is_empty()
        || !matches!(
            record.kind.as_str(),
            "entry" | "platform" | "setting" | "override"
        )
        || (!record.value.is_null() && record.version.as_deref().unwrap_or("").is_empty())
    {
        return Err("SYNC_INVALID_RESPONSE".into());
    }
    Ok(conn.execute(
        "INSERT INTO sync_shadow(kind,id,value_json,version,seen_cursor) VALUES(?,?,?,?,?)
         ON CONFLICT(kind,id) DO UPDATE SET value_json=excluded.value_json,version=excluded.version,
         seen_cursor=excluded.seen_cursor WHERE excluded.seen_cursor>=sync_shadow.seen_cursor",
        params![
            record.kind,
            record.id,
            record.value.to_string(),
            record.version,
            cursor
        ],
    )? > 0)
}

fn pending_for(conn: &Connection, record: &Record) -> StorageResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_changes WHERE kind=? AND id=?)",
        params![record.kind, record.id],
        |r| r.get(0),
    )?)
}

fn apply_page(tx: &Transaction<'_>, mut page: Page) -> StorageResult<()> {
    let (ledger_id, cursor) = ledger_cursor(tx)?;
    if page.ledger_id != ledger_id || page.cursor < cursor {
        return Err("SYNC_INVALID_RESPONSE".into());
    }
    // Pages can contain several revisions of one row. Preserve the last in feed order,
    // then apply parents first, without making unacknowledged local edits disappear.
    let mut last = BTreeMap::new();
    for r in page.records.drain(..) {
        last.insert((r.kind.clone(), r.id.clone()), r);
    }
    let mut records: Vec<_> = last.into_values().collect();
    records.sort_by_key(records::apply_order);
    for record in records {
        if remember(tx, &record, page.cursor)? && !pending_for(tx, &record)? {
            records::apply(tx, &record)?;
        }
    }
    tx.execute("UPDATE sync_binding SET cursor=?", [page.cursor])?;
    Ok(())
}

// total_changes is connection-local; data_version changes when another connection commits.
pub fn data_stamp(conn: &Connection) -> StorageResult<(u64, i64)> {
    let other_changes = conn.pragma_query_value(None, "data_version", |row| row.get(0))?;
    Ok((conn.total_changes(), other_changes))
}

#[cfg(test)]
pub fn bind(conn: &mut Connection, url: &str, bootstrap: &Value, mode: &str) -> StorageResult<()> {
    let stamp = data_stamp(conn)?;
    bind_checked(conn, url, bootstrap, mode, stamp)
}

pub fn bind_checked(
    conn: &mut Connection,
    url: &str,
    bootstrap: &Value,
    mode: &str,
    expected_stamp: (u64, i64),
) -> StorageResult<()> {
    let page: Page = serde_json::from_value(bootstrap.clone())?;
    if page.ledger_id.is_empty() || page.cursor < 0 || url.is_empty() {
        return Err("SYNC_INVALID_RESPONSE".into());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_unbound(&tx)?;
    if data_stamp(&tx)? != expected_stamp {
        return Err("SYNC_PREVIEW_STALE".into());
    }
    tx.execute(
        "INSERT INTO sync_binding VALUES (1,?,?,0)",
        params![url, page.ledger_id],
    )?;
    match mode {
        "publish" if page.cursor == 0 && page.records.is_empty() => {
            let seed = new_queue_row(&tx, true)?;
            let mut query = tx.prepare("SELECT kind,id,value_json FROM sync_local")?;
            let mut rows = query.query([])?;
            while let Some(r) = rows.next()? {
                store_change(
                    &tx,
                    &seed,
                    &Change {
                        kind: r.get(0)?,
                        id: r.get(1)?,
                        base_version: None,
                        before: Value::Null,
                        after: decode_json(r.get(2)?)?,
                    },
                )?;
            }
        }
        "replace" if page.cursor > 0 => {
            let backup = backup::encode(read_ledger(&tx)?)?;
            tx.execute("INSERT OR REPLACE INTO sync_recovery VALUES(1,?)", [backup])?;
            tx.execute_batch(
                "DELETE FROM entries; DELETE FROM platforms; DELETE FROM salary_overrides;
                              UPDATE settings SET default_salary_cents=0, warning_floor_cents=0;",
            )?;
            apply_page(&tx, page)?;
            backup::validate(&read_ledger(&tx)?)?;
        }
        _ => return Err("SYNC_BIND_MODE".into()),
    }
    tx.commit()?;
    Ok(())
}

pub fn previous_backup(conn: &Connection) -> StorageResult<Option<String>> {
    Ok(conn
        .query_row("SELECT contents FROM sync_recovery", [], |r| r.get(0))
        .optional()?)
}

pub fn unbind(conn: &mut Connection) -> StorageResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("DELETE FROM sync_queue; DELETE FROM sync_shadow; DELETE FROM sync_last_payment; DELETE FROM sync_binding;")?;
    tx.commit()?;
    Ok(())
}

pub fn status(conn: &Connection) -> StorageResult<Value> {
    let binding: Option<(String, String, i64)> = conn
        .query_row("SELECT url,ledger_id,cursor FROM sync_binding", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    let pending: i64 = conn.query_row("SELECT count(*) FROM sync_queue", [], |r| r.get(0))?;
    let mut conflicts = vec![];
    let mut query = conn.prepare("SELECT operation_id,conflict_json FROM sync_queue WHERE conflict_json IS NOT NULL ORDER BY seq")?;
    let mut rows = query.query([])?;
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        let candidates = decode_json(r.get(1)?)?;
        let op = operation(conn, &id)?;
        let pairs = reconcile::matched(&op, &candidates)?;
        conflicts.push(
            json!({"operationId": id, "changes": op.changes, "records": candidates["records"],
            "requiresRestore": reconcile::requires_restore(&pairs)}),
        );
    }
    let (url, ledger, cursor) = binding
        .map(|(u, l, c)| (Some(u), Some(l), c))
        .unwrap_or((None, None, 0));
    let undoable = conn
        .prepare("SELECT entry_id FROM sync_undoable ORDER BY entry_id")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(
        json!({"bound":url.is_some(),"url":url,"ledgerId":ledger,"cursor":cursor,"pending":pending,"conflicts":conflicts,"undoableIds":undoable,
        "hasPreviousBackup": conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_recovery)", [], |r| r.get::<_,bool>(0))?}),
    )
}

// Preserve FIFO within a record and across a bill's dependency on its platform.
// A disputed entry need not prevent an unrelated bill from reaching the other device.
fn sendable(conn: &Connection) -> StorageResult<Option<String>> {
    let mut blocked = BTreeSet::new();
    let mut q =
        conn.prepare("SELECT operation_id,conflict_json IS NOT NULL FROM sync_queue ORDER BY seq")?;
    let mut rows = q.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let conflicted: bool = row.get(1)?;
        if !conflicted && blocked.is_empty() {
            return Ok(Some(id));
        }
        let changes = operation(conn, &id)?.changes;
        let keys = changes
            .iter()
            .map(|c| (c.kind.clone(), c.id.clone()))
            .collect::<Vec<_>>();
        let depends = keys.iter().any(|key| blocked.contains(key))
            || changes
                .iter()
                .filter(|c| c.kind == "entry")
                .filter_map(|c| c.after["platformId"].as_str())
                .any(|platform| blocked.contains(&("platform".to_owned(), platform.to_owned())));
        if !conflicted && !depends {
            return Ok(Some(id));
        }
        blocked.extend(keys);
    }
    Ok(None)
}

fn bound_endpoint(conn: &Connection) -> StorageResult<(String, String)> {
    conn.query_row("SELECT url,ledger_id FROM sync_binding", [], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })
    .optional()?
    .ok_or_else(|| "SYNC_NOT_BOUND".into())
}

fn require_endpoint(conn: &Connection, url: &str, ledger: &str) -> StorageResult<()> {
    let (current_url, current_ledger) = bound_endpoint(conn)?;
    if current_url != url || current_ledger != ledger {
        return Err("SYNC_LEDGER_MISMATCH".into());
    }
    Ok(())
}

#[cfg(test)]
pub fn next(conn: &Connection) -> StorageResult<Option<Value>> {
    let (url, ledger) = bound_endpoint(conn)?;
    next_for(conn, &url, &ledger)
}

pub fn next_for(conn: &Connection, url: &str, ledger: &str) -> StorageResult<Option<Value>> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    require_endpoint(&tx, url, ledger)?;
    let wire = freeze_next(&tx)?;
    tx.commit()?;
    Ok(wire)
}

pub(super) fn freeze_next(tx: &Transaction<'_>) -> StorageResult<Option<Value>> {
    // Freeze the exact request before releasing SQLite for the network await.
    // After a crash or an independent conflict decision, this request is retried first.
    let frozen = tx
        .query_row(
            "SELECT wire_json FROM sync_queue WHERE wire_json IS NOT NULL",
            [],
            |r| decode_json(r.get(0)?),
        )
        .optional()?;
    if frozen.is_some() {
        return Ok(frozen);
    }
    let Some(id) = sendable(tx)? else {
        return Ok(None);
    };
    let wire = serde_json::to_value(operation(tx, &id)?)?;
    tx.execute(
        "UPDATE sync_queue SET wire_json=? WHERE operation_id=?",
        params![wire.to_string(), id],
    )?;
    Ok(Some(wire))
}

#[cfg(test)]
pub fn pull(conn: &mut Connection, page: &Value) -> StorageResult<()> {
    let (url, ledger) = bound_endpoint(conn)?;
    pull_for(conn, &url, &ledger, page)
}

pub fn pull_for(conn: &mut Connection, url: &str, ledger: &str, page: &Value) -> StorageResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_endpoint(&tx, url, ledger)?;
    apply_page(&tx, serde_json::from_value(page.clone())?)?;
    tx.commit()?;
    Ok(())
}

pub use reconcile::{ack, conflict, resolve};
