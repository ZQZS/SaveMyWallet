-- Some v2 development releases already have these objects. Keep their queue and ownership rows.
CREATE UNIQUE INDEX IF NOT EXISTS sync_one_in_flight ON sync_queue((1)) WHERE wire_json IS NOT NULL;
CREATE TABLE IF NOT EXISTS sync_last_payment (entry_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_recovery (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), contents TEXT NOT NULL
);
DROP VIEW IF EXISTS sync_undoable;
CREATE VIEW sync_undoable AS
 SELECT p.entry_id, p.operation_id FROM sync_last_payment p
 WHERE p.operation_id=COALESCE(
    (SELECT CASE WHEN q.conflict_json IS NULL THEN c.operation_id ELSE '' END FROM sync_changes c
     JOIN sync_queue q USING(operation_id) WHERE c.kind='entry' AND c.id=p.entry_id ORDER BY q.seq DESC LIMIT 1),
    (SELECT version FROM sync_shadow WHERE kind='entry' AND id=p.entry_id));
PRAGMA user_version = 3;
