use super::StorageResult;
use chrono::{Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::BTreeMap;
use std::ops::Deref;

pub(super) fn expire(conn: &Connection, today: NaiveDate) -> StorageResult<()> {
    let oldest = super::history::retention_start(today)?;
    conn.execute(
        "DELETE FROM ai_undo_operation WHERE local_day < ?",
        [oldest],
    )?;
    Ok(())
}

fn row_image(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT value_json FROM sync_local WHERE kind=? AND id=?")?
        .query_row([kind, id], |row| row.get(0))
        .optional()
}

struct Capture {
    action: &'static str,
    sync_start: i64,
    before: BTreeMap<(&'static str, String), Option<String>>,
}

pub(super) struct LedgerTransaction<'a> {
    tx: Transaction<'a>,
    capture: Option<Capture>,
}

impl<'a> Deref for LedgerTransaction<'a> {
    type Target = Transaction<'a>;

    fn deref(&self) -> &Self::Target {
        &self.tx
    }
}

impl<'a> LedgerTransaction<'a> {
    pub(super) fn new(tx: Transaction<'a>, action: Option<&'static str>) -> StorageResult<Self> {
        let capture = if let Some(action) = action {
            let sync_start =
                tx.query_row("SELECT COALESCE(MAX(seq),0) FROM sync_queue", [], |row| {
                    row.get(0)
                })?;
            Some(Capture {
                action,
                sync_start,
                before: BTreeMap::new(),
            })
        } else {
            None
        };
        Ok(Self { tx, capture })
    }

    pub(super) fn remember<'b>(
        &mut self,
        kind: &'static str,
        ids: impl IntoIterator<Item = &'b str>,
    ) -> StorageResult<()> {
        let Some(capture) = &mut self.capture else {
            return Ok(());
        };
        for id in ids {
            let key = (kind, id.to_owned());
            if let std::collections::btree_map::Entry::Vacant(entry) = capture.before.entry(key) {
                entry.insert(row_image(&self.tx, kind, id)?);
            }
        }
        Ok(())
    }

    // These IDs came from INSERT ... RETURNING in this transaction. They didn't exist before.
    pub(super) fn inserted<'b>(
        &mut self,
        kind: &'static str,
        ids: impl IntoIterator<Item = &'b str>,
    ) {
        if let Some(capture) = &mut self.capture {
            for id in ids {
                capture.before.entry((kind, id.to_owned())).or_insert(None);
            }
        }
    }

    pub(super) fn commit(self) -> StorageResult<()> {
        if let Some(capture) = self.capture {
            capture.finish(&self.tx)?;
        }
        Ok(self.tx.commit()?)
    }
}

impl Capture {
    fn finish(self, tx: &Transaction<'_>) -> StorageResult<()> {
        let mut record = tx.prepare_cached(
            "INSERT INTO ai_undo_change(slot,kind,id,before_json,after_json,sync_operation_id)
             VALUES (1,?1,?2,?3,?4,(SELECT c.operation_id FROM sync_changes c JOIN sync_queue q USING(operation_id)
                 WHERE c.kind=?1 AND c.id=?2 AND q.seq>?5 ORDER BY q.seq DESC LIMIT 1))"
        )?;
        let mut started = false;
        for ((kind, id), before) in self.before {
            let after = row_image(tx, kind, &id)?;
            if before == after {
                continue;
            }
            if !started {
                // Replace the old ticket only after finding an actual business change.
                // The transaction rolls back both the ticket and the ledger on any failure.
                let when = Local::now();
                tx.execute("DELETE FROM ai_undo_operation WHERE slot=1", [])?;
                tx.execute(
                    "INSERT INTO ai_undo_operation(slot,token,action,created_at,local_day)
                            VALUES (1,lower(hex(randomblob(16))),?1,?2,?3)",
                    params![
                        self.action,
                        when.timestamp_millis(),
                        when.date_naive().to_string()
                    ],
                )?;
                super::sync::tag_ai_queue(tx, self.sync_start)?;
                started = true;
            }
            record.execute(params![
                kind,
                id,
                before.as_deref().unwrap_or("null"),
                after.as_deref().unwrap_or("null"),
                self.sync_start
            ])?;
        }
        Ok(())
    }
}
