use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, error::Error, time::Duration};

pub type StorageResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
const MAX_CENTS: i64 = 99_999_999_900;
const LAST_MONTH: u32 = 2099 * 12 + 11;

pub mod backup;
mod installments;
pub mod sync;
pub use installments::set_installment_voided;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Platform {
    id: String,
    name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    id: String,
    platform_id: String,
    title: String,
    month: String,
    amount_cents: i64,
    status: String,
    kind: String,
    installment_index: Option<u32>,
    installment_count: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_installment_id"
    )]
    installment_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    voided: bool,
}

fn deserialize_installment_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

impl Entry {
    fn has_valid_installment_id(&self) -> bool {
        self.installment_id.as_ref().is_none_or(|id| {
            self.kind == "installment"
                && id.len() == 32
                && id
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    default_salary_cents: i64,
    warning_floor_cents: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ledger {
    platforms: Vec<Platform>,
    entries: Vec<Entry>,
    settings: Settings,
    #[serde(deserialize_with = "backup::read_overrides")]
    salary_overrides: BTreeMap<String, i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillInput {
    platform_id: String,
    title: String,
    month: String,
    amount_cents: i64,
    kind: String,
    installment_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmInput {
    id: String,
    title: String,
    month: String,
    amount_cents: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetInput {
    month: String,
    default_salary_cents: i64,
    warning_floor_cents: i64,
    override_salary_cents: Option<i64>,
}

pub fn migrate(conn: &mut Connection) -> StorageResult<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: u32 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    match version {
        0 => {
            tx.execute_batch(include_str!("schema_v1.sql"))?;
            tx.execute_batch(include_str!("initial_data.sql"))?;
        }
        1..=5 => (),
        _ => return Err("账本版本较新，请升级应用后重试。".into()),
    }
    if version < 2 {
        tx.execute_batch(include_str!("schema_v2.sql"))?;
    }
    if version < 3 {
        // Development builds shared user_version 2 while these two columns were introduced.
        let has_column = |name: &str| -> rusqlite::Result<bool> {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sync_queue') WHERE name=?)",
                [name],
                |row| row.get(0),
            )
        };
        if !has_column("undo_of")? {
            tx.execute("ALTER TABLE sync_queue ADD COLUMN undo_of TEXT", [])?;
        }
        let legacy_queue = !has_column("wire_json")?;
        if legacy_queue {
            tx.execute("ALTER TABLE sync_queue ADD COLUMN wire_json TEXT", [])?;
        }
        tx.execute_batch(include_str!("schema_v3.sql"))?;
        if legacy_queue {
            // It may already have been committed remotely with its response lost.
            // Keep its request exactly as queued before accepting any further local edits.
            sync::freeze_next(&tx)?;
        }
    }
    if version < 4 {
        tx.execute_batch(include_str!("schema_v4.sql"))?;
    }
    if version < 5 {
        tx.execute_batch(include_str!("schema_v5.sql"))?;
    }
    tx.commit()?;
    Ok(())
}

pub fn snapshot(conn: &mut Connection) -> StorageResult<Ledger> {
    let tx = conn.transaction()?;
    let ledger = read_ledger(&tx)?;
    tx.commit()?;
    Ok(ledger)
}

fn read_ledger(tx: &Connection) -> StorageResult<Ledger> {
    let platforms = {
        let mut query = tx.prepare("SELECT id, name FROM platforms ORDER BY rowid")?;
        let rows = query.query_map([], |r| {
            Ok(Platform {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let entries = {
        let mut query = tx.prepare(
            "SELECT id, platform_id, title, month, amount_cents, status, kind,
                    installment_index, installment_count, voided, installment_id FROM entries ORDER BY month, rowid",
        )?;
        let rows = query.query_map([], |r| {
            Ok(Entry {
                id: r.get(0)?,
                platform_id: r.get(1)?,
                title: r.get(2)?,
                month: r.get(3)?,
                amount_cents: r.get(4)?,
                status: r.get(5)?,
                kind: r.get(6)?,
                installment_index: r.get(7)?,
                installment_count: r.get(8)?,
                voided: r.get(9)?,
                installment_id: r.get(10)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let settings = tx.query_row(
        "SELECT default_salary_cents, warning_floor_cents FROM settings WHERE id = 1",
        [],
        |r| {
            Ok(Settings {
                default_salary_cents: r.get(0)?,
                warning_floor_cents: r.get(1)?,
            })
        },
    )?;
    let salary_overrides = {
        let mut query = tx.prepare("SELECT month, salary_cents FROM salary_overrides")?;
        let rows = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()?
    };
    Ok(Ledger {
        platforms,
        entries,
        settings,
        salary_overrides,
    })
}

fn month_index(month: &str) -> StorageResult<u32> {
    let invalid = "请选择 1900 年至 2099 年间有效的还款月份。";
    let (year, number) = month.split_once('-').ok_or(invalid)?;
    if year.len() != 4
        || number.len() != 2
        || !year
            .bytes()
            .chain(number.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return Err(invalid.into());
    }
    let year: u32 = year.parse()?;
    let number: u32 = number.parse()?;
    if !(1900..=2099).contains(&year) || !(1..=12).contains(&number) {
        return Err(invalid.into());
    }
    Ok(year * 12 + number - 1)
}

fn check_amount(cents: i64, minimum: i64) -> StorageResult<()> {
    if !(minimum..=MAX_CENTS).contains(&cents) {
        return Err("金额超出允许范围，请检查后重试。".into());
    }
    Ok(())
}

fn bill_title(input: &str) -> StorageResult<&str> {
    let title = input.trim();
    if !(1..=120).contains(&title.chars().count()) || title.contains('\0') {
        return Err("请填写 1 到 120 个字的款项名称。".into());
    }
    Ok(title)
}

fn platform_name(name: &str) -> StorageResult<&str> {
    let name = name.trim();
    if !(1..=40).contains(&name.chars().count()) || name.contains('\0') {
        return Err("请填写 1 到 40 个字的平台名称。".into());
    }
    Ok(name)
}

pub fn add_platform(conn: &Connection, name: &str) -> StorageResult<String> {
    let name = platform_name(name)?;
    let tx = conn.unchecked_transaction()?;
    let id: String = tx
        .query_row(
            "INSERT INTO platforms (id,name) VALUES(
                CASE WHEN EXISTS(SELECT 1 FROM sync_binding)
                     THEN 'p.' || lower(hex(lower(?1))) ELSE lower(hex(randomblob(16))) END,
                ?1) ON CONFLICT(name) DO NOTHING RETURNING id",
            [name],
            |r| r.get(0),
        )
        .optional()?
        .ok_or("同名平台已存在，可直接选择。")?;
    sync::capture(&tx, [("platform", id.as_str())])?;
    tx.commit()?;
    Ok(id)
}

pub fn add_bill(conn: &mut Connection, input: BillInput) -> StorageResult<()> {
    let title = bill_title(&input.title)?;
    let start = month_index(&input.month)?;
    check_amount(input.amount_cents, 1)?;
    let (periods, status) = match input.kind.as_str() {
        "single" => (1, "due"),
        "estimate" => (1, "estimated"),
        "installment" if (1..=120).contains(&input.installment_count) => {
            (input.installment_count, "due")
        }
        "installment" => return Err("分期期数应为 1 到 120。".into()),
        _ => return Err("未知的账单类型。".into()),
    };
    if start + periods - 1 > LAST_MONTH {
        return Err("最后一期超出支持的还款月份。".into());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM platforms WHERE id = ?1)",
        [&input.platform_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err("所选还款平台不存在，请重新选择。".into());
    }
    let mut ids = Vec::<String>::new();
    let split = input.kind == "installment";
    let installment_id: Option<String> = if split {
        Some(tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?)
    } else {
        None
    };
    {
        let mut insert = tx.prepare(
            "INSERT INTO entries (platform_id, title, month, amount_cents, status, kind,
             installment_index, installment_count, installment_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id",
        )?;
        for offset in 0..periods {
            let index = start + offset;
            let month = format!("{:04}-{:02}", index / 12, index % 12 + 1);
            ids.push(insert.query_row(
                params![
                    input.platform_id,
                    title,
                    month,
                    input.amount_cents,
                    status,
                    input.kind,
                    split.then_some(offset + 1),
                    split.then_some(periods),
                    installment_id
                ],
                |r| r.get(0),
            )?);
        }
    }
    sync::capture(&tx, ids.iter().map(|id| ("entry", id.as_str())))?;
    tx.commit()?;
    Ok(())
}

pub fn confirm(conn: &Connection, input: ConfirmInput) -> StorageResult<()> {
    let title = bill_title(&input.title)?;
    month_index(&input.month)?;
    check_amount(input.amount_cents, 1)?;
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE entries SET title = ?1, month = ?2, amount_cents = ?3, status = 'due'
         WHERE id = ?4 AND status = 'estimated' AND voided = 0",
        params![title, input.month, input.amount_cents, input.id],
    )?;
    if changed == 0 {
        return Err("STALE_ESTIMATE".into());
    }
    sync::capture(&tx, [("entry", input.id.as_str())])?;
    tx.commit()?;
    Ok(())
}

fn change_voided(tx: &Transaction<'_>, ids: &[String], voided: bool) -> StorageResult<Vec<String>> {
    let mut changed = Vec::new();
    let mut update = tx.prepare("UPDATE entries SET voided = ?1 WHERE id = ?2 AND voided <> ?1")?;
    for id in ids {
        if update.execute(params![voided, id])? == 0 {
            continue;
        }
        tx.execute("DELETE FROM sync_last_payment WHERE entry_id = ?", [id])?;
        changed.push(id.clone());
    }
    sync::capture(tx, changed.iter().map(|id| ("entry", id.as_str())))?;
    Ok(changed)
}

pub fn set_entry_voided(conn: &mut Connection, id: &str, voided: bool) -> StorageResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM entries WHERE id = ?)",
        [id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err("ENTRY_NOT_FOUND".into());
    }
    change_voided(&tx, &[id.to_owned()], voided)?;
    tx.commit()?;
    Ok(())
}

pub fn mark_payment(
    conn: &mut Connection,
    ids: &[String],
    paid: bool,
) -> StorageResult<Vec<String>> {
    change_payment(conn, ids, paid, false)
}

pub fn undo_payment(
    conn: &mut Connection,
    ids: &[String],
    paid: bool,
) -> StorageResult<Vec<String>> {
    change_payment(conn, ids, paid, true)
}

fn change_payment(
    conn: &mut Connection,
    ids: &[String],
    paid: bool,
    undo: bool,
) -> StorageResult<Vec<String>> {
    let (from, to) = if paid {
        ("due", "paid")
    } else {
        ("paid", "due")
    };
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let guarded = undo && sync::bound(&tx)?;
    let mut changed = Vec::new();
    {
        let mut update = tx.prepare(
            "UPDATE entries SET status = ?1 WHERE id = ?2 AND status = ?3 AND voided = 0
             AND (?4 = 0 OR EXISTS(SELECT 1 FROM sync_undoable WHERE entry_id=?2))",
        )?;
        for id in ids {
            if update.execute(params![to, id, from, guarded])? > 0 {
                changed.push(id.clone());
            }
        }
    }
    if let Some(operation) = sync::capture(&tx, changed.iter().map(|id| ("entry", id.as_str())))? {
        if guarded {
            tx.execute(
                "UPDATE sync_queue SET undo_of=(SELECT operation_id FROM sync_last_payment LIMIT 1)
                WHERE operation_id=?",
                [&operation],
            )?;
        }
        tx.execute("DELETE FROM sync_last_payment", [])?;
        if !undo {
            for id in &changed {
                tx.execute(
                    "INSERT INTO sync_last_payment VALUES (?,?)",
                    params![id, operation],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(changed)
}

pub fn budget(conn: &mut Connection, input: BudgetInput) -> StorageResult<()> {
    month_index(&input.month)?;
    check_amount(input.default_salary_cents, 0)?;
    check_amount(input.warning_floor_cents, 0)?;
    if let Some(amount) = input.override_salary_cents {
        check_amount(amount, 0)?;
    }
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE settings SET default_salary_cents = ?1, warning_floor_cents = ?2 WHERE id = 1",
        params![input.default_salary_cents, input.warning_floor_cents],
    )?;
    if let Some(amount) = input.override_salary_cents {
        tx.execute(
            "INSERT INTO salary_overrides (month, salary_cents) VALUES (?1, ?2)
             ON CONFLICT(month) DO UPDATE SET salary_cents = excluded.salary_cents",
            params![input.month, amount],
        )?;
    } else {
        tx.execute(
            "DELETE FROM salary_overrides WHERE month = ?1",
            [&input.month],
        )?;
    }
    sync::capture(
        &tx,
        [
            ("setting", "defaultSalaryCents"),
            ("setting", "warningFloorCents"),
            ("override", input.month.as_str()),
        ],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
