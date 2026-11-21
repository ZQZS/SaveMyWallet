use super::{ai_undo_capture, check_entry_amount, history, sync, Entry, StorageResult};
use chrono::Local;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;

const CONFLICT: &str = "AI_UNDO_CONFLICT";
const STALE: &str = "AI_UNDO_STALE";
const PREVIEW_LIMIT: usize = 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUndoPreview {
    token: String,
    action: String,
    created_at: i64,
    entry_count: usize,
    platform_count: usize,
    budget_count: usize,
    items: Vec<PreviewItem>,
    blocked: bool,
    blocked_reason: Option<String>,
}

#[derive(Serialize)]
struct PreviewItem {
    kind: String,
    id: String,
    label: String,
}

pub(super) struct UndoChange {
    pub(super) kind: String,
    pub(super) id: String,
    pub(super) before: Value,
    pub(super) after: Value,
    pub(super) target: Value,
    pub(super) sync_operation_id: Option<String>,
}

struct Plan {
    preview: AiUndoPreview,
    changes: Vec<UndoChange>,
}

// For an edited object, undo only the properties the AI actually changed. Missing optional
// properties (such as voided=false) are distinct from stored JSON values.
pub(super) fn inverse(before: &Value, after: &Value, current: &Value) -> Option<Value> {
    if after == current {
        return Some(before.clone());
    }
    let (old, written, mut live) = (
        before.as_object()?,
        after.as_object()?,
        current.as_object()?.clone(),
    );
    for key in old
        .keys()
        .chain(written.keys().filter(|key| !old.contains_key(*key)))
    {
        if old.get(key) == written.get(key) {
            continue;
        }
        if live.get(key) != written.get(key) {
            return None;
        }
        if let Some(value) = old.get(key) {
            live.insert(key.clone(), value.clone());
        } else {
            live.remove(key);
        }
    }
    Some(Value::Object(live))
}

// Both snapshots can be valid individually while their combined fields violate an invariant,
// e.g. a fully deposited entry whose amount is now zero cannot go back to "due".
fn compatible_merge(kind: &str, target: &Value, original: &Value) -> bool {
    if kind != "entry" || target.is_null() || target == original {
        return true;
    }
    let Ok(entry) = serde_json::from_value::<Entry>(target.clone()) else {
        return false;
    };
    check_entry_amount(&entry.kind, entry.amount_cents, entry.deposit_cents).is_ok()
        && !(entry.status == "due" && entry.amount_cents == 0)
        && !(entry.status == "estimated" && entry.kind != "estimate")
}

// A newly-created platform or installment series must not take later manual rows with it.
// Ignore entries which this same operation created and will remove in the same transaction.
fn has_dependants(conn: &Connection) -> StorageResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM ai_undo_change c JOIN entries e ON e.platform_id=c.id
            WHERE c.kind='platform' AND c.before_json='null'
              AND NOT EXISTS(SELECT 1 FROM ai_undo_change d WHERE d.kind='entry' AND d.id=e.id AND d.before_json='null')
            UNION ALL
            SELECT 1 FROM ai_undo_change c JOIN entries e ON e.installment_id=json_extract(c.after_json, '$.installmentId')
            WHERE c.kind='entry' AND c.before_json='null'
              AND NOT EXISTS(SELECT 1 FROM ai_undo_change d WHERE d.kind='entry' AND d.id=e.id AND d.before_json='null')
        )", [], |r| r.get(0),
    )?)
}

fn plan(conn: &Connection, expected: Option<&str>) -> StorageResult<Option<Plan>> {
    let header = conn
        .query_row(
            "SELECT token,action,created_at FROM ai_undo_operation WHERE slot=1 AND (?1 IS NULL OR token=?1)",
            [expected],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((token, action, created_at)) = header else {
        return Ok(None);
    };
    let mut preview = AiUndoPreview {
        token,
        action,
        created_at,
        entry_count: 0,
        platform_count: 0,
        budget_count: 0,
        items: Vec::new(),
        blocked: false,
        blocked_reason: None,
    };
    let mut changes = Vec::new();
    let mut keys = conn.prepare(
        "SELECT kind,id,before_json,after_json,conflicted,sync_operation_id FROM ai_undo_change WHERE slot=1 ORDER BY kind,id"
    )?;
    let mut current = conn.prepare("SELECT value_json FROM sync_local WHERE kind=?1 AND id=?2")?;
    let mut rows = keys.query([])?;
    while let Some(row) = rows.next()? {
        let kind: String = row.get(0)?;
        let id: String = row.get(1)?;
        let before: Value = serde_json::from_str(row.get_ref(2)?.as_str()?)?;
        let after: Value = serde_json::from_str(row.get_ref(3)?.as_str()?)?;
        let conflicted: bool = row.get(4)?;
        match kind.as_str() {
            "entry" => preview.entry_count += 1,
            "platform" => preview.platform_count += 1,
            "setting" | "override" => preview.budget_count += 1,
            _ => return Err(CONFLICT.into()),
        }
        if preview.items.len() < PREVIEW_LIMIT {
            let image = if after.is_null() { &before } else { &after };
            let label = image["title"]
                .as_str()
                .or_else(|| image["name"].as_str())
                .unwrap_or(&id);
            preview.items.push(PreviewItem {
                kind: kind.clone(),
                id: id.clone(),
                label: label.to_owned(),
            });
        }
        let live: Option<String> = current.query_row([&kind, &id], |r| r.get(0)).optional()?;
        let live = live
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or(Value::Null);
        if let Some(target) = inverse(&before, &after, &live)
            .filter(|target| !conflicted && compatible_merge(&kind, target, &before))
        {
            changes.push(UndoChange {
                kind,
                id,
                before,
                after,
                target,
                sync_operation_id: row.get(5)?,
            });
        } else {
            preview.blocked_reason = Some(CONFLICT.into());
        }
    }
    if preview.blocked_reason.is_none()
        && changes.iter().any(|change| {
            change.target.is_null() && matches!(change.kind.as_str(), "entry" | "platform")
        })
        && has_dependants(conn)?
    {
        preview.blocked_reason = Some(CONFLICT.into());
    }
    if preview.blocked_reason.is_none() {
        if let Err(error) = sync::check_ai_undo(conn, &changes) {
            let reason = error.to_string();
            if !reason.starts_with("AI_UNDO_") {
                return Err(error);
            }
            preview.blocked_reason = Some(reason);
        }
    }
    preview.blocked = preview.blocked_reason.is_some();
    Ok(Some(Plan { preview, changes }))
}

pub(crate) fn preview(conn: &mut Connection) -> StorageResult<Option<AiUndoPreview>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    ai_undo_capture::expire(&tx, Local::now().date_naive())?;
    let preview = plan(&tx, None)?.map(|plan| plan.preview);
    tx.commit()?;
    Ok(preview)
}

// Binding an offline ledger can publish the original AI change under its own ID.
// The caller has already expired the ticket and has not installed the binding yet.
pub(super) fn changes_for_publish(conn: &Connection) -> StorageResult<Vec<UndoChange>> {
    Ok(plan(conn, None)?
        .filter(|plan| !plan.preview.blocked)
        .map(|plan| plan.changes)
        .unwrap_or_default())
}

pub(crate) fn apply(conn: &mut Connection, token: &str) -> StorageResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    ai_undo_capture::expire(&tx, Local::now().date_naive())?;
    let Some(mut plan) = plan(&tx, Some(token))? else {
        tx.commit()?;
        return Err(STALE.into());
    };
    if let Some(reason) = plan.preview.blocked_reason {
        return Err(reason.into());
    }
    history::checkpoint(&tx)?;
    plan.changes.sort_by_key(
        |change| match (change.kind.as_str(), change.target.is_null()) {
            ("entry", true) => 0,
            ("platform", true) => 1,
            ("platform", false) => 2,
            ("entry", false) => 3,
            _ => 4,
        },
    );
    for change in &plan.changes {
        sync::apply_local_undo_value(&tx, &change.kind, &change.id, &change.target)?;
    }
    sync::capture_undo(&tx, &plan.changes)?;
    tx.execute("DELETE FROM ai_undo_operation WHERE slot=1", [])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
