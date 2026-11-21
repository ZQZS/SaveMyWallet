use super::*;
use crate::ledger::ai_undo::UndoChange;

// The reviewed write and its outbox rows are still protected by the same
// transaction. A receipt can later prove exactly which group made these changes.
pub(in crate::ledger) fn tag_ai_queue(tx: &Transaction<'_>, start: i64) -> StorageResult<()> {
    let mut query = tx.prepare(
        "SELECT operation_id,'ai.'||a.token||'.'||operation_id
        FROM sync_queue CROSS JOIN ai_undo_operation a WHERE seq>? AND a.slot=1",
    )?;
    let ids = query
        .query_map([start], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (original, tagged) in ids {
        tx.execute(
            "UPDATE sync_queue SET operation_id=?1 WHERE operation_id=?2",
            params![tagged, original],
        )?;
        tx.execute(
            "UPDATE sync_changes SET base_version=?1 WHERE base_version=?2 AND operation_id IN
            (SELECT operation_id FROM sync_queue WHERE seq>?3)",
            params![tagged, original, start],
        )?;
        tx.execute(
            "UPDATE sync_last_payment SET operation_id=?1 WHERE operation_id=?2",
            params![tagged, original],
        )?;
        tx.execute(
            "UPDATE sync_queue SET undo_of=?1 WHERE undo_of=?2 AND seq>?3",
            params![tagged, original, start],
        )?;
    }
    Ok(())
}

pub(in crate::ledger) fn apply_local_undo_value(
    conn: &Connection,
    kind: &str,
    id: &str,
    value: &Value,
) -> StorageResult<()> {
    let record = Record {
        kind: kind.to_owned(),
        id: id.to_owned(),
        value: value.clone(),
        version: None,
    };
    records::apply(conn, &record).map_err(|error| {
        if let Some(sql) = error.downcast_ref::<rusqlite::Error>() {
            if sql.sqlite_error_code() != Some(rusqlite::ErrorCode::ConstraintViolation) {
                return error;
            }
        }
        "AI_UNDO_CONFLICT".into()
    })
}

// An operation with a frozen request may already be committed on the server.
// Withdraw only requests that this device can prove have never left the queue.
#[derive(Default)]
struct Sources<'a> {
    withdraw: BTreeSet<&'a str>,
    published: BTreeSet<&'a str>,
}

fn sources<'a>(conn: &Connection, changes: &'a [UndoChange]) -> StorageResult<Sources<'a>> {
    let mut result = Sources::default();
    if !bound(conn)? {
        return Ok(result);
    }
    let supports: bool =
        conn.query_row("SELECT supports_ai_revert FROM sync_binding", [], |r| {
            r.get(0)
        })?;
    let mut queue = conn.prepare_cached(
        "SELECT q.operation_id,q.wire_json IS NOT NULL,q.conflict_json IS NOT NULL,
                c.before_json,c.after_json,c.base_version
         FROM sync_changes c JOIN sync_queue q USING(operation_id)
         WHERE c.kind=?1 AND c.id=?2 ORDER BY q.seq DESC LIMIT 1",
    )?;
    let mut baseline =
        conn.prepare_cached("SELECT version,value_json FROM sync_shadow WHERE kind=? AND id=?")?;
    let mut predecessor = conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM sync_changes WHERE operation_id=? AND kind=? AND id=?)",
    )?;
    let mut group_sizes = BTreeMap::new();
    for change in changes {
        let source = change
            .sync_operation_id
            .as_deref()
            .ok_or("AI_UNDO_SYNC_CONFLICT")?;
        let pending = queue
            .query_row(params![change.kind, change.id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, bool>(2)?,
                    decode_json(r.get(3)?)?,
                    decode_json(r.get(4)?)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .optional()?;
        if let Some((id, frozen, conflict, before, after, base_version)) = pending {
            if conflict {
                return Err("AI_UNDO_SYNC_CONFLICT".into());
            }
            if frozen || id != source {
                return Err("AI_UNDO_SYNC_PENDING".into());
            }
            let expected_before =
                crate::ledger::ai_undo::inverse(&change.before, &change.after, &after);
            let default_setting = change.kind == "setting"
                && before.is_null()
                && expected_before.as_ref() == Some(&json!(0));
            if !default_setting && expected_before.as_ref() != Some(&before) {
                return Err("AI_UNDO_SYNC_CONFLICT".into());
            }
            // A pull can advance the shadow while an unsent local edit masks it.
            // Removing that edit must never restore an obsolete predecessor.
            let has_predecessor: bool = predecessor
                .query_row(params![base_version, change.kind, change.id], |r| r.get(0))?;
            if !has_predecessor {
                let (version, value) = baseline
                    .query_row(params![change.kind, change.id], |r| {
                        Ok((r.get::<_, Option<String>>(0)?, decode_json(r.get(1)?)?))
                    })
                    .optional()?
                    .unwrap_or((None, Value::Null));
                if base_version != version || before != value {
                    return Err("AI_UNDO_SYNC_CONFLICT".into());
                }
            }
            *group_sizes.entry(source).or_insert(0usize) += 1;
            result.withdraw.insert(source);
        } else {
            if !supports {
                return Err("AI_UNDO_SYNC_UPGRADE".into());
            }
            result.published.insert(source);
        }
    }
    let mut count =
        conn.prepare_cached("SELECT COUNT(*) FROM sync_changes WHERE operation_id=?")?;
    for (source, captured) in group_sizes {
        let queued: usize = count.query_row([source], |r| r.get(0))?;
        if queued != captured {
            return Err("AI_UNDO_SYNC_CONFLICT".into());
        }
    }
    Ok(result)
}

pub(in crate::ledger) fn check_ai_undo(
    conn: &Connection,
    changes: &[UndoChange],
) -> StorageResult<()> {
    sources(conn, changes).map(|_| ())
}

pub(in crate::ledger) fn capture_undo(
    tx: &Transaction<'_>,
    changes: &[UndoChange],
) -> StorageResult<()> {
    let sources = sources(tx, changes)?;
    for id in sources.withdraw {
        tx.execute("DELETE FROM sync_queue WHERE operation_id=?", [id])?;
    }
    for change in changes.iter().filter(|change| change.kind == "entry") {
        tx.execute(
            "DELETE FROM sync_last_payment WHERE entry_id=? AND operation_id=?",
            params![change.id, change.sync_operation_id],
        )?;
    }
    if !sources.published.is_empty() {
        let keys = changes
            .iter()
            .filter(|change| {
                change
                    .sync_operation_id
                    .as_deref()
                    .is_some_and(|id| sources.published.contains(id))
            })
            .map(|change| (change.kind.as_str(), change.id.as_str()));
        let inverse = capture(tx, keys)?.ok_or("AI_UNDO_SYNC_CONFLICT")?;
        tx.execute(
            "UPDATE sync_queue SET revert_operation_ids=? WHERE operation_id=?",
            params![serde_json::to_string(&sources.published)?, inverse],
        )?;
    }
    Ok(())
}
