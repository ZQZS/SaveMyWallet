use super::*;

// A reply must describe exactly the operation sent. A truncated or unrelated
// reply must never make a device forget its only durable copy of a change.
pub(super) fn matched(op: &Operation, response: &Value) -> StorageResult<Vec<(Change, Record)>> {
    let mut records: BTreeMap<_, _> = BTreeMap::new();
    for r in serde_json::from_value::<Vec<Record>>(response["records"].clone())? {
        if records.insert((r.kind.clone(), r.id.clone()), r).is_some() {
            return Err("SYNC_INVALID_RESPONSE".into());
        }
    }
    if records.len() != op.changes.len() {
        return Err("SYNC_INVALID_RESPONSE".into());
    }
    let mut pairs = vec![];
    for change in &op.changes {
        let r = records
            .remove(&(change.kind.clone(), change.id.clone()))
            .ok_or("SYNC_INVALID_RESPONSE")?;
        pairs.push((change.clone(), r));
    }
    pairs.sort_by_key(|(_, r)| records::apply_order(r));
    Ok(pairs)
}

pub(super) fn requires_restore(pairs: &[(Change, Record)]) -> bool {
    pairs.iter().any(|(change, base)| {
        change.kind == "entry"
            && change.after.is_object()
            && change.before != change.after
            && base.value["voided"] == true
            && change.before["voided"] != true
            && change.after["voided"] != true
    })
}

fn reply_cursor(conn: &Connection, reply: &Value) -> StorageResult<i64> {
    let cursor = reply["cursor"].as_i64().unwrap_or(ledger_cursor(conn)?.1);
    if cursor < 0 {
        return Err("SYNC_INVALID_RESPONSE".into());
    }
    Ok(cursor)
}

fn shadow(conn: &Connection, kind: &str, id: &str) -> StorageResult<Record> {
    Ok(conn.query_row(
        "SELECT value_json,version FROM sync_shadow WHERE kind=? AND id=?",
        [kind, id],
        |r| {
            Ok(Record {
                kind: kind.into(),
                id: id.into(),
                value: decode_json(r.get(0)?)?,
                version: r.get(1)?,
            })
        },
    )?)
}

fn is_payment(change: &Change) -> bool {
    if change.kind != "entry"
        || !matches!(
            (
                change.before["status"].as_str(),
                change.after["status"].as_str()
            ),
            (Some("due"), Some("paid")) | (Some("paid"), Some("due"))
        )
    {
        return false;
    }
    let mut expected = change.before.clone();
    expected["status"] = change.after["status"].clone();
    expected == change.after
}

// Replay only the intent of a subsequent local operation. In particular a
// payment after a disputed confirmation changes its status, not its amount/month.
fn desired(change: &Change, base: &Value) -> Value {
    if change.kind == "entry" && change.before.is_object() && base.is_object() {
        if change.before["voided"] != change.after["voided"] {
            let mut value = base.clone();
            let row = value.as_object_mut().unwrap();
            if change.after["voided"] == true {
                row.insert("voided".into(), json!(true));
            } else {
                row.remove("voided");
            }
            return value;
        }
        if base["voided"] == true {
            // Later payments or confirmations cannot revive a voided entry.
            return base.clone();
        }
    }
    if is_payment(change) && base.is_object() {
        // A superseded confirmation may have left no outstanding balance to pay or undo.
        if base["amountCents"] == 0 || base["status"] == "estimated" {
            return base.clone();
        }
        let mut value = base.clone();
        value["status"] = change.after["status"].clone();
        value
    } else if change.kind == "entry"
        && change.before["status"] == "estimated"
        && base["status"] == "paid"
        && base["amountCents"] != 0
    {
        let mut value = change.after.clone();
        value["status"] = json!("paid");
        value
    } else {
        change.after.clone()
    }
}

fn delete_change(conn: &Connection, op: &str, change: &Change) -> StorageResult<()> {
    conn.execute(
        "DELETE FROM sync_changes WHERE operation_id=? AND kind=? AND id=?",
        params![op, change.kind, change.id],
    )?;
    conn.execute(
        "DELETE FROM sync_queue WHERE operation_id=? AND NOT EXISTS(
        SELECT 1 FROM sync_changes WHERE operation_id=?)",
        [op, op],
    )?;
    Ok(())
}

// Subsequent operations on this record are still unsent. Rebase them
// without changing their order, preserving disjoint changes within each group.
fn rebase(
    tx: &Connection,
    after_seq: i64,
    mut base: Record,
    skip_undo_of: Option<&str>,
) -> StorageResult<Record> {
    let mut query = tx.prepare(
        "SELECT c.kind,c.id,c.base_version,c.before_json,c.after_json,c.operation_id,q.undo_of,q.wire_json IS NOT NULL
        FROM sync_changes c JOIN sync_queue q USING(operation_id)
        WHERE c.kind=? AND c.id=? AND q.seq>? ORDER BY q.seq",
    )?;
    let later = query
        .query_map(params![base.kind, base.id, after_seq], |r| {
            Ok((
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, bool>(7)?,
                read_change(r)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, undo_of, frozen, old) in later {
        if frozen {
            return Err("SYNC_OPERATION_IN_FLIGHT".into());
        }
        let lost_undo = skip_undo_of.is_some()
            && skip_undo_of == undo_of.as_deref()
            && skip_undo_of == old.base_version.as_deref()
            && is_payment(&old);
        let value = desired(&old, &base.value);
        if lost_undo || value == base.value {
            delete_change(tx, &id, &old)?;
        } else {
            let change = Change {
                base_version: base.version.clone(),
                before: base.value.clone(),
                after: value.clone(),
                ..old
            };
            store_change(tx, &id, &change)?;
            base.value = value;
            base.version = Some(id);
        }
    }
    Ok(base)
}

pub fn ack(conn: &mut Connection, response: &Value) -> StorageResult<()> {
    let id = response["operationId"]
        .as_str()
        .ok_or("SYNC_INVALID_RESPONSE")?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let cursor = reply_cursor(&tx, response)?;
    let item: Option<(i64, bool)> = tx
        .query_row(
            "SELECT seq,wire_json IS NOT NULL FROM sync_queue WHERE operation_id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((seq, frozen)) = item else {
        return Ok(());
    }; // already acknowledged
    if !frozen {
        return Err("SYNC_INVALID_RESPONSE".into());
    }
    let op = operation(&tx, id)?;
    let changed: BTreeSet<String> = serde_json::from_value(response["changedIds"].clone())?;
    let pairs = matched(&op, response)?;
    tx.execute("DELETE FROM sync_queue WHERE operation_id=?", [id])?;
    for (change, record) in pairs {
        if change.after != record.value {
            return Err("SYNC_INVALID_RESPONSE".into());
        }
        remember(&tx, &record, cursor)?;
        let skip_undo = if is_payment(&change) && !changed.contains(&record.id) {
            Some(id)
        } else {
            None
        };
        let local = rebase(&tx, seq, record, skip_undo)?;
        // If all writes to this row finished, use the most recent known server row.
        let projection = if pending_for(&tx, &local)? {
            local
        } else {
            shadow(&tx, &local.kind, &local.id)?
        };
        records::apply(&tx, &projection)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn conflict(conn: &mut Connection, id: &str, response: &Value) -> StorageResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let frozen: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_queue WHERE operation_id=? AND wire_json IS NOT NULL)",
        [id],
        |r| r.get(0),
    )?;
    if response["code"] != "conflict" || !frozen {
        return Err("SYNC_INVALID_RESPONSE".into());
    }
    let cursor = reply_cursor(&tx, response)?;
    for (_, r) in matched(&operation(&tx, id)?, response)? {
        remember(&tx, &r, cursor)?;
    }
    tx.execute(
        "UPDATE sync_queue SET conflict_json=?,wire_json=NULL WHERE operation_id=?",
        params![response.to_string(), id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn resolve(conn: &mut Connection, id: &str, choice: &str) -> StorageResult<()> {
    if !matches!(choice, "local" | "remote") {
        return Err("SYNC_INVALID_CHOICE".into());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (seq,mut stored): (i64,Value) = tx.query_row(
        "SELECT seq,conflict_json FROM sync_queue WHERE operation_id=? AND conflict_json IS NOT NULL",
        [id], |r| Ok((r.get(0)?,decode_json(r.get(1)?)?))).optional()?.ok_or("SYNC_CONFLICT_CHANGED")?;
    let pairs = matched(&operation(&tx, id)?, &stored)?;
    let mut latest = vec![];
    let mut stale = false;
    for (_, r) in &pairs {
        let current = shadow(&tx, &r.kind, &r.id)?;
        stale |= current.version != r.version || current.value != r.value;
        latest.push(current);
    }
    if stale {
        stored["records"] = serde_json::to_value(latest)?;
        tx.execute(
            "UPDATE sync_queue SET conflict_json=? WHERE operation_id=?",
            params![stored.to_string(), id],
        )?;
        tx.commit()?;
        return Err("SYNC_CONFLICT_CHANGED".into());
    }
    if choice == "local" && requires_restore(&pairs) {
        return Err("SYNC_ENTRY_VOIDED".into());
    }
    // Preserve sequence relative to dependent local edits; a decision is a fresh
    // request, with the server version the user has just reviewed.
    let replacement = fresh_id(&tx)?;
    if choice == "local" {
        tx.execute(
            "UPDATE sync_last_payment SET operation_id=? WHERE operation_id=?",
            params![replacement, id],
        )?;
        tx.execute(
            "UPDATE sync_queue SET undo_of=? WHERE undo_of=?",
            params![replacement, id],
        )?;
    }
    tx.execute(
        "UPDATE sync_queue SET operation_id=?,conflict_json=NULL,seed=0 WHERE operation_id=?",
        params![replacement, id],
    )?;
    for (old, mut base) in pairs {
        let value = desired(&old, &base.value);
        if choice == "local" && value != base.value {
            store_change(
                &tx,
                &replacement,
                &Change {
                    base_version: base.version.clone(),
                    before: base.value.clone(),
                    after: value.clone(),
                    ..old
                },
            )?;
            base.value = value;
            base.version = Some(replacement.clone());
        } else {
            delete_change(&tx, &replacement, &old)?;
        }
        let local = rebase(&tx, seq, base, None)?;
        records::apply(&tx, &local)?;
    }
    tx.commit()?;
    Ok(())
}
