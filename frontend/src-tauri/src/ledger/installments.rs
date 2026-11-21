use super::{change_voided, LedgerWrite, StorageResult};
use rusqlite::{Connection, TransactionBehavior};

pub fn set_installment_voided<'a>(
    write: impl Into<LedgerWrite<'a>>,
    id: &str,
    voided: bool,
) -> StorageResult<Vec<String>> {
    let tx = write.into().begin(TransactionBehavior::Immediate)?;
    let members = installment_members(&tx, id)?;
    let changed = change_voided(&tx, &members, voided)?;
    tx.commit()?;
    Ok(changed)
}

fn installment_members(conn: &Connection, id: &str) -> StorageResult<Vec<String>> {
    // With a stored group ID, inspect every member for a consistent schedule.
    // For older rows, consider only matching schedules and require one row per period.
    let mut query = conn.prepare(
        "WITH candidates AS (
            SELECT e.id, e.installment_index, source.installment_count, source.installment_id,
                e.kind = 'installment' AND e.platform_id = source.platform_id
                AND e.title = source.title AND e.amount_cents = source.amount_cents
                AND e.installment_count = source.installment_count
                AND e.month = strftime('%Y-%m', source.month || '-01',
                    printf('%+d months', e.installment_index - source.installment_index)) AS same_schedule
            FROM entries source JOIN entries e ON e.installment_id IS source.installment_id
            WHERE source.id = ?1 AND source.kind = 'installment'
        )
        SELECT id, installment_index, installment_count, same_schedule FROM candidates
        WHERE installment_id IS NOT NULL OR same_schedule
        ORDER BY installment_index",
    )?;
    let mut rows = query.query([id])?;
    let mut members = Vec::new();
    let mut count = 0;
    while let Some(row) = rows.next()? {
        let index: usize = row.get(1)?;
        count = row.get(2)?;
        if !row.get::<_, bool>(3)? || index != members.len() + 1 {
            return Err("INSTALLMENT_GROUP_UNAVAILABLE".into());
        }
        members.push(row.get(0)?);
    }
    if members.is_empty() || members.len() != count {
        return Err("INSTALLMENT_GROUP_UNAVAILABLE".into());
    }
    Ok(members)
}
