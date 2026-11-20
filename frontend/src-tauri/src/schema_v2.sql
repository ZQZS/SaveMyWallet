CREATE TABLE sync_binding (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), url TEXT NOT NULL,
    ledger_id TEXT NOT NULL, cursor INTEGER NOT NULL CHECK(cursor >= 0)
);
CREATE TABLE sync_shadow (
    kind TEXT NOT NULL, id TEXT NOT NULL, value_json TEXT NOT NULL,
    version TEXT, seen_cursor INTEGER NOT NULL, PRIMARY KEY(kind, id)
);
CREATE TABLE sync_queue (
    seq INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
    seed INTEGER NOT NULL DEFAULT 0, conflict_json TEXT
);
CREATE TABLE sync_changes (
    operation_id TEXT NOT NULL REFERENCES sync_queue(operation_id) ON UPDATE CASCADE ON DELETE CASCADE,
    kind TEXT NOT NULL, id TEXT NOT NULL, base_version TEXT, before_json TEXT NOT NULL,
    after_json TEXT NOT NULL, PRIMARY KEY(operation_id, kind, id)
);
CREATE INDEX sync_changes_key ON sync_changes(kind, id);
CREATE TABLE sync_recovery (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), contents TEXT NOT NULL
);

-- Use the same wire representation for initial publication and later individual writes.
CREATE VIEW sync_local(kind, id, value_json) AS
 SELECT 'platform', id, json_object('id', id, 'name', name) FROM platforms
 UNION ALL SELECT 'entry', id, json_object(
    'id', id, 'platformId', platform_id, 'title', title, 'month', month,
    'amountCents', amount_cents, 'status', status, 'kind', kind,
    'installmentIndex', installment_index, 'installmentCount', installment_count) FROM entries
 UNION ALL SELECT 'setting', 'defaultSalaryCents', CAST(default_salary_cents AS TEXT) FROM settings
 UNION ALL SELECT 'setting', 'warningFloorCents', CAST(warning_floor_cents AS TEXT) FROM settings
 UNION ALL SELECT 'override', month, CAST(salary_cents AS TEXT) FROM salary_overrides;
PRAGMA user_version = 2;
