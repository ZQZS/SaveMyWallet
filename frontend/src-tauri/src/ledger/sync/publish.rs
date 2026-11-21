use super::*;
use crate::ledger::ai_undo::UndoChange;

// Keep seed=true on the first request so the server can reject a racing first publisher.
// It contains the real ledger before the AI action, including the two effective global
// budgets even when both are zero. Unrelated later manual records also travel in the seed.
pub(super) fn enqueue(tx: &Transaction<'_>, changes: &[UndoChange]) -> StorageResult<()> {
    let seed = new_queue_row(tx, true)?;
    let seed_seq = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO sync_changes(operation_id,kind,id,base_version,before_json,after_json)
         SELECT ?1,kind,id,NULL,'null',value_json FROM sync_local",
        [&seed],
    )?;
    // A previously bound ledger may have a receipt from another server. Only source IDs
    // created for this binding can authorize a future server revert.
    tx.execute(
        "UPDATE ai_undo_change SET sync_operation_id=NULL WHERE sync_operation_id IS NOT NULL",
        [],
    )?;
    if changes.is_empty() {
        return Ok(());
    }

    let source = new_queue_row(tx, false)?;
    for change in changes {
        if change.before.is_null() {
            tx.execute(
                "DELETE FROM sync_changes WHERE operation_id=? AND kind=? AND id=?",
                params![seed, change.kind, change.id],
            )?;
        } else {
            store_change(
                tx,
                &seed,
                &Change {
                    kind: change.kind.clone(),
                    id: change.id.clone(),
                    base_version: None,
                    before: Value::Null,
                    after: change.before.clone(),
                },
            )?;
        }
        store_change(
            tx,
            &source,
            &Change {
                kind: change.kind.clone(),
                id: change.id.clone(),
                base_version: (!change.before.is_null()).then(|| seed.clone()),
                before: change.before.clone(),
                after: change.after.clone(),
            },
        )?;
    }
    tag_ai_queue(tx, seed_seq)?;
    tx.execute(
        "UPDATE ai_undo_change SET sync_operation_id=(SELECT operation_id FROM sync_queue WHERE seq>?1)",
        [seed_seq],
    )?;
    // Manual edits to an AI-touched row must stay chronologically after the AI write.
    // For example, the server requires payment before a subsequent manual void, and the
    // journal must still prove exactly which fields the original AI action owned.
    capture(
        tx,
        changes
            .iter()
            .map(|change| (change.kind.as_str(), change.id.as_str())),
    )?;
    Ok(())
}
