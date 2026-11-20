use super::Record;
use crate::ledger::{
    bill_title, check_amount, month_index, platform_name, Entry, Platform, StorageResult,
    LAST_MONTH,
};
use rusqlite::{params, Connection};
use serde_json::Value;

// SQLite checks the platform foreign key immediately, including during a bootstrap.
pub(super) fn apply_order(record: &Record) -> u8 {
    match (record.kind.as_str(), record.value.is_null()) {
        ("entry", true) => 0,
        ("platform", true) => 1,
        ("platform", false) => 2,
        ("entry", false) => 3,
        _ => 4,
    }
}

fn money(value: &Value) -> StorageResult<i64> {
    let cents = value.as_i64().ok_or("SYNC_INVALID_RECORD")?;
    check_amount(cents, 0)?;
    Ok(cents)
}

fn apply_entry(conn: &Connection, id: &str, value: &Value) -> StorageResult<()> {
    let entry: Entry = serde_json::from_value(value.clone())?;
    let month = month_index(&entry.month)?;
    check_amount(entry.amount_cents, 1)?;
    if entry.id != id
        || !entry.has_valid_installment_id()
        || bill_title(&entry.title)? != entry.title
        || !matches!(entry.status.as_str(), "due" | "paid" | "estimated")
        || (entry.status == "estimated" && entry.kind != "estimate")
    {
        return Err("SYNC_INVALID_RECORD".into());
    }
    match (
        entry.kind.as_str(),
        entry.installment_index,
        entry.installment_count,
    ) {
        ("single" | "estimate", None, None) => (),
        ("installment", Some(index), Some(count))
            if (1..=120).contains(&count) && (1..=count).contains(&index) =>
        {
            let start = month - (index - 1);
            if start < 1900 * 12 || start + count - 1 > LAST_MONTH {
                return Err("SYNC_INVALID_RECORD".into());
            }
            if let Some(group) = &entry.installment_id {
                let inconsistent: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM entries WHERE installment_id=?1 AND id<>?2 AND (
                     platform_id<>?3 OR title<>?4 OR amount_cents<>?5 OR installment_count<>?6 OR
                     date(month||'-01', printf('%d months', 1-installment_index))
                     <>date(?7||'-01', printf('%d months', 1-?8))))",
                    params![
                        group,
                        id,
                        entry.platform_id,
                        entry.title,
                        entry.amount_cents,
                        count,
                        entry.month,
                        index
                    ],
                    |row| row.get(0),
                )?;
                if inconsistent {
                    return Err("SYNC_INVALID_RECORD".into());
                }
            }
        }
        _ => return Err("SYNC_INVALID_RECORD".into()),
    }
    conn.execute("INSERT INTO entries
            (id,platform_id,title,month,amount_cents,status,kind,installment_index,installment_count,voided,installment_id)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
            ON CONFLICT(id) DO UPDATE SET platform_id=excluded.platform_id, title=excluded.title,
            month=excluded.month, amount_cents=excluded.amount_cents, status=excluded.status,
            kind=excluded.kind, installment_index=excluded.installment_index, installment_count=excluded.installment_count,
            voided=excluded.voided, installment_id=excluded.installment_id",
        params![entry.id, entry.platform_id, entry.title, entry.month, entry.amount_cents,
            entry.status, entry.kind, entry.installment_index, entry.installment_count, entry.voided,
            entry.installment_id])?;
    Ok(())
}

pub(super) fn apply(conn: &Connection, record: &Record) -> StorageResult<()> {
    let id = record.id.as_str();
    if id.is_empty() || id != id.trim() || id.contains('\0') {
        return Err("SYNC_INVALID_RECORD".into());
    }
    match record.kind.as_str() {
        "entry" if record.value.is_null() => {
            conn.execute("DELETE FROM entries WHERE id=?1", [id])?;
        }
        "entry" => apply_entry(conn, id, &record.value)?,
        "platform" if record.value.is_null() => {
            // Do not cascade: pending local entries can still reference this platform.
            conn.execute("DELETE FROM platforms WHERE id=?1", [id])?;
        }
        "platform" => {
            let platform: Platform = serde_json::from_value(record.value.clone())?;
            if platform.id != id || platform_name(&platform.name)? != platform.name {
                return Err("SYNC_INVALID_RECORD".into());
            }
            conn.execute(
                "INSERT INTO platforms (id,name) VALUES (?1,?2)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                params![id, platform.name],
            )?;
        }
        "setting" => {
            let cents = if record.value.is_null() {
                0
            } else {
                money(&record.value)?
            };
            let update = match id {
                "defaultSalaryCents" => "UPDATE settings SET default_salary_cents=?1 WHERE id=1",
                "warningFloorCents" => "UPDATE settings SET warning_floor_cents=?1 WHERE id=1",
                _ => return Err("SYNC_INVALID_RECORD".into()),
            };
            conn.execute(update, [cents])?;
        }
        "override" => {
            month_index(id)?;
            if record.value.is_null() {
                conn.execute("DELETE FROM salary_overrides WHERE month=?1", [id])?;
            } else {
                conn.execute(
                    "INSERT INTO salary_overrides (month,salary_cents) VALUES (?1,?2)
                    ON CONFLICT(month) DO UPDATE SET salary_cents=excluded.salary_cents",
                    params![id, money(&record.value)?],
                )?;
            }
        }
        _ => return Err("SYNC_INVALID_RECORD".into()),
    }
    Ok(())
}
