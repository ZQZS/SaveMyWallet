use super::{
    bill_title, check_amount, month_index, platform_name, snapshot, Ledger, StorageResult,
    LAST_MONTH,
};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::de::{Error as _, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
};

const FORMAT: &str = "SaveMyWallet";
const INVALID: &str = "BACKUP_INVALID";

#[derive(Serialize)]
struct Backup {
    format: &'static str,
    version: u32,
    ledger: Ledger,
}

// Check the file identifier and version before interpreting its ledger schema.
#[derive(Deserialize)]
struct Envelope<'a> {
    format: String,
    version: u32,
    #[serde(borrow)]
    ledger: &'a RawValue,
}

#[derive(Serialize)]
pub struct BackupPreview {
    pub platforms: usize,
    pub entries: usize,
    pub overrides: usize,
}

pub fn export(conn: &mut Connection) -> StorageResult<String> {
    let ledger = snapshot(conn).map_err(|_| "BACKUP_READ")?;
    encode(ledger)
}

pub(super) fn encode(ledger: Ledger) -> StorageResult<String> {
    let backup = Backup {
        format: FORMAT,
        version: if ledger
            .entries
            .iter()
            .any(|entry| entry.installment_id.is_some())
        {
            3
        } else if ledger.entries.iter().any(|entry| entry.voided) {
            2
        } else {
            1
        },
        ledger,
    };
    let contents = serde_json::to_string(&backup).map_err(|_| "BACKUP_READ")?;
    check_size(&contents)?;
    Ok(contents)
}

fn check_size(contents: &str) -> StorageResult<()> {
    if contents.len() > crate::backup_files::MAX_BACKUP_BYTES {
        return Err("FILE_TOO_LARGE".into());
    }
    Ok(())
}

// serde's normal BTreeMap decoder keeps only the last duplicate month.
pub(super) fn read_overrides<'de, D>(deserializer: D) -> Result<BTreeMap<String, i64>, D::Error>
where
    D: Deserializer<'de>,
{
    struct Overrides;
    impl<'de> Visitor<'de> for Overrides {
        type Value = BTreeMap<String, i64>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a map of unique months to salary amounts")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            while let Some((month, amount)) = map.next_entry()? {
                if result.insert(month, amount).is_some() {
                    return Err(A::Error::custom("duplicate salary override month"));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Overrides)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id == id.trim() && !id.contains('\0')
}

pub(super) fn validate(ledger: &Ledger) -> StorageResult<()> {
    let mut platform_ids = HashSet::new();
    let mut names = HashSet::new();
    for platform in &ledger.platforms {
        if !valid_id(&platform.id)
            || !platform_ids.insert(platform.id.as_str())
            || platform_name(&platform.name)? != platform.name
            || !names.insert(platform.name.to_ascii_lowercase())
        {
            return Err(INVALID.into());
        }
    }
    let mut entry_ids = HashSet::new();
    let mut schedules = BTreeMap::new();
    let mut periods = HashSet::new();
    for entry in &ledger.entries {
        let month = month_index(&entry.month)?;
        check_amount(entry.amount_cents, 1)?;
        if !valid_id(&entry.id)
            || !entry_ids.insert(entry.id.as_str())
            || !entry.has_valid_installment_id()
            || !platform_ids.contains(entry.platform_id.as_str())
            || bill_title(&entry.title)? != entry.title
            || !matches!(entry.status.as_str(), "due" | "paid" | "estimated")
            || (entry.status == "estimated" && entry.kind != "estimate")
        {
            return Err(INVALID.into());
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
                    return Err(INVALID.into());
                }
                if let Some(id) = entry.installment_id.as_deref() {
                    let schedule = (
                        &entry.platform_id,
                        &entry.title,
                        entry.amount_cents,
                        start,
                        count,
                    );
                    if schedules.entry(id).or_insert(schedule) != &schedule
                        || !periods.insert((id, index))
                    {
                        return Err(INVALID.into());
                    }
                }
            }
            _ => return Err(INVALID.into()),
        }
    }
    check_amount(ledger.settings.default_salary_cents, 0)?;
    check_amount(ledger.settings.warning_floor_cents, 0)?;
    for (month, salary) in &ledger.salary_overrides {
        month_index(month)?;
        check_amount(*salary, 0)?;
    }
    Ok(())
}

fn decode(contents: &str) -> StorageResult<Ledger> {
    check_size(contents)?;
    let text = contents.strip_prefix('\u{feff}').unwrap_or(contents);
    let envelope: Envelope<'_> = serde_json::from_str(text).map_err(|_| "BACKUP_FORMAT")?;
    if envelope.format != FORMAT {
        return Err("BACKUP_FORMAT".into());
    }
    if !(1..=3).contains(&envelope.version) {
        return Err("BACKUP_VERSION".into());
    }
    let ledger: Ledger = serde_json::from_str(envelope.ledger.get()).map_err(|_| INVALID)?;
    if ledger.entries.iter().any(|entry| {
        (envelope.version < 2 && entry.voided)
            || (envelope.version < 3 && entry.installment_id.is_some())
    }) {
        return Err(INVALID.into());
    }
    validate(&ledger).map_err(|_| INVALID)?;
    Ok(ledger)
}

pub fn preview(contents: &str) -> StorageResult<BackupPreview> {
    let ledger = decode(contents)?;
    Ok(BackupPreview {
        platforms: ledger.platforms.len(),
        entries: ledger.entries.len(),
        overrides: ledger.salary_overrides.len(),
    })
}

fn clear_ledger(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch("DELETE FROM entries; DELETE FROM platforms; DELETE FROM salary_overrides; DELETE FROM settings;")
}

fn replace(tx: &Transaction<'_>, ledger: Ledger) -> rusqlite::Result<()> {
    clear_ledger(tx)?;
    {
        let mut insert = tx.prepare("INSERT INTO platforms (id, name) VALUES (?1, ?2)")?;
        for platform in ledger.platforms {
            insert.execute(params![platform.id, platform.name])?;
        }
    }
    {
        let mut insert = tx.prepare(
            "INSERT INTO entries (id, platform_id, title, month, amount_cents, status, kind, installment_index, installment_count, voided, installment_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
        )?;
        for entry in ledger.entries {
            insert.execute(params![
                entry.id,
                entry.platform_id,
                entry.title,
                entry.month,
                entry.amount_cents,
                entry.status,
                entry.kind,
                entry.installment_index,
                entry.installment_count,
                entry.voided,
                entry.installment_id
            ])?;
        }
    }
    tx.execute(
        "INSERT INTO settings (id, default_salary_cents, warning_floor_cents) VALUES (1, ?1, ?2)",
        params![
            ledger.settings.default_salary_cents,
            ledger.settings.warning_floor_cents
        ],
    )?;
    {
        let mut insert =
            tx.prepare("INSERT INTO salary_overrides (month, salary_cents) VALUES (?1, ?2)")?;
        for (month, amount) in ledger.salary_overrides {
            insert.execute(params![month, amount])?;
        }
    }
    Ok(())
}

pub fn restore(conn: &mut Connection, contents: &str) -> StorageResult<()> {
    super::sync::require_unbound(conn)?;
    let ledger = decode(contents)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "BACKUP_WRITE")?;
    super::sync::require_unbound(&tx)?;
    replace(&tx, ledger).map_err(|_| "BACKUP_WRITE")?;
    Ok(tx.commit().map_err(|_| "BACKUP_WRITE")?)
}

pub fn reset(conn: &mut Connection, confirmation: &str) -> StorageResult<()> {
    if confirmation != "重置" {
        return Err("RESET_CONFIRMATION".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "BACKUP_WRITE")?;
    super::sync::require_unbound(&tx)?;
    clear_ledger(&tx).map_err(|_| "BACKUP_WRITE")?;
    tx.execute("DELETE FROM sync_recovery", [])
        .map_err(|_| "BACKUP_WRITE")?;
    tx.execute_batch(include_str!("../initial_data.sql"))
        .map_err(|_| "BACKUP_WRITE")?;
    Ok(tx.commit().map_err(|_| "BACKUP_WRITE")?)
}
