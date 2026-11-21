use super::{read_ledger, Ledger, StorageResult};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct ReviewedLedger {
    ledger: Ledger,
    revision: String,
}

fn revision(conn: &Connection) -> StorageResult<String> {
    // total_changes tracks this connection's writes, data_version other connections' commits.
    let external: i64 = conn.query_row("PRAGMA main.data_version", [], |row| row.get(0))?;
    Ok(format!("{}:{external}", conn.total_changes()))
}

pub(crate) fn snapshot(conn: &mut Connection) -> StorageResult<ReviewedLedger> {
    let tx = conn.transaction()?;
    let ledger = read_ledger(&tx)?;
    let revision = revision(&tx)?;
    tx.commit()?;
    Ok(ReviewedLedger { ledger, revision })
}

pub(crate) struct LedgerWrite<'a> {
    connection: &'a Connection,
    expected: Option<&'a str>,
}

impl<'a> LedgerWrite<'a> {
    pub(crate) fn new(connection: &'a Connection, expected: Option<&'a str>) -> Self {
        Self {
            connection,
            expected,
        }
    }

    pub(super) fn begin(self, behavior: TransactionBehavior) -> StorageResult<Transaction<'a>> {
        // Acquire SQLite's writer lock before checking a reviewed action. A sync
        // pull or a second app instance cannot change its target before commit.
        let behavior = if self.expected.is_some() {
            TransactionBehavior::Immediate
        } else {
            behavior
        };
        let tx = Transaction::new_unchecked(self.connection, behavior)?;
        if let Some(expected) = self.expected {
            if revision(&tx)? != expected {
                return Err("AI_ACTION_STALE".into());
            }
        }
        Ok(tx)
    }
}

impl<'a> From<&'a Connection> for LedgerWrite<'a> {
    fn from(conn: &'a Connection) -> Self {
        Self::new(conn, None)
    }
}

impl<'a> From<&'a mut Connection> for LedgerWrite<'a> {
    fn from(conn: &'a mut Connection) -> Self {
        Self::new(conn, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::{add_platform, migrate};
    use std::time::Duration;

    #[test]
    fn reads_preserve_a_review_and_local_or_external_writes_invalidate_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ledger.sqlite3");
        let mut conn = Connection::open(&path).unwrap();
        migrate(&mut conn).unwrap();
        let before = snapshot(&mut conn).unwrap();
        assert_eq!(before.revision, snapshot(&mut conn).unwrap().revision);

        add_platform(LedgerWrite::new(&conn, Some(&before.revision)), "审核通过").unwrap();
        let repeated = add_platform(LedgerWrite::new(&conn, Some(&before.revision)), "重复动作");
        assert_eq!(repeated.unwrap_err().to_string(), "AI_ACTION_STALE");

        let next = snapshot(&mut conn).unwrap();
        let external = Connection::open(&path).unwrap();
        add_platform(&external, "另一实例").unwrap();
        let stale = add_platform(LedgerWrite::new(&conn, Some(&next.revision)), "过期动作");
        assert_eq!(stale.unwrap_err().to_string(), "AI_ACTION_STALE");

        let after = snapshot(&mut conn).unwrap();
        assert_eq!(
            after.ledger.platforms.len(),
            before.ledger.platforms.len() + 2
        );
    }

    #[test]
    fn checked_transaction_keeps_the_writer_lock_until_it_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ledger.sqlite3");
        let mut conn = Connection::open(&path).unwrap();
        migrate(&mut conn).unwrap();
        let other = Connection::open(&path).unwrap();
        other.busy_timeout(Duration::ZERO).unwrap();
        let reviewed = snapshot(&mut conn).unwrap();
        let tx = LedgerWrite::new(&conn, Some(&reviewed.revision))
            .begin(TransactionBehavior::Deferred)
            .unwrap();
        let blocked = other
            .execute("UPDATE settings SET warning_floor_cents=1", [])
            .unwrap_err();
        assert_eq!(
            blocked.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        tx.commit().unwrap();
        assert_eq!(
            other
                .execute("UPDATE settings SET warning_floor_cents=1", [])
                .unwrap(),
            1
        );
    }
}
