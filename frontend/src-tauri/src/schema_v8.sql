-- One confirmed AI write on this device. Its row images use the sync_local format.
CREATE TABLE ai_undo_operation (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    token TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    local_day TEXT NOT NULL
);
CREATE TABLE ai_undo_change (
    slot INTEGER NOT NULL REFERENCES ai_undo_operation(slot) ON DELETE CASCADE,
    kind TEXT NOT NULL, id TEXT NOT NULL,
    before_json TEXT NOT NULL, after_json TEXT NOT NULL,
    sync_operation_id TEXT,
    conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0, 1)),
    PRIMARY KEY (slot, kind, id)
);

-- Remember intervening edits even if a subsequent write restores the same value.
-- For an update, protect only fields changed by the AI. An insertion owns the whole row.
CREATE TRIGGER ai_undo_entry_update AFTER UPDATE ON entries
WHEN EXISTS (SELECT 1 FROM ai_undo_change WHERE slot=1 AND kind='entry' AND id=OLD.id AND conflicted=0)
BEGIN
    UPDATE ai_undo_change SET conflicted=1
    WHERE slot=1 AND kind='entry' AND id=OLD.id AND EXISTS (
        SELECT 1 FROM json_each(json_array(
            CASE WHEN OLD.id IS NOT NEW.id THEN 'id' END,
            CASE WHEN OLD.platform_id IS NOT NEW.platform_id THEN 'platformId' END,
            CASE WHEN OLD.title IS NOT NEW.title THEN 'title' END,
            CASE WHEN OLD.month IS NOT NEW.month THEN 'month' END,
            CASE WHEN OLD.amount_cents IS NOT NEW.amount_cents THEN 'amountCents' END,
            CASE WHEN OLD.deposit_cents IS NOT NEW.deposit_cents THEN 'depositCents' END,
            CASE WHEN OLD.status IS NOT NEW.status THEN 'status' END,
            CASE WHEN OLD.kind IS NOT NEW.kind THEN 'kind' END,
            CASE WHEN OLD.installment_index IS NOT NEW.installment_index THEN 'installmentIndex' END,
            CASE WHEN OLD.installment_count IS NOT NEW.installment_count THEN 'installmentCount' END,
            CASE WHEN OLD.installment_id IS NOT NEW.installment_id THEN 'installmentId' END,
            CASE WHEN OLD.voided IS NOT NEW.voided THEN 'voided' END
        )) AS changed
        WHERE changed.value IS NOT NULL AND (before_json='null' OR
            json_extract(before_json,'$.'||changed.value) IS NOT json_extract(after_json,'$.'||changed.value))
    );
END;
CREATE TRIGGER ai_undo_entry_delete AFTER DELETE ON entries BEGIN
    UPDATE ai_undo_change SET conflicted=1 WHERE slot=1 AND kind='entry' AND id=OLD.id AND conflicted=0;
END;
CREATE TRIGGER ai_undo_platform_update AFTER UPDATE ON platforms
WHEN OLD.id IS NOT NEW.id OR OLD.name COLLATE BINARY IS NOT NEW.name BEGIN
    UPDATE ai_undo_change SET conflicted=1 WHERE slot=1 AND kind='platform' AND id=OLD.id AND conflicted=0;
END;
CREATE TRIGGER ai_undo_platform_delete AFTER DELETE ON platforms BEGIN
    UPDATE ai_undo_change SET conflicted=1 WHERE slot=1 AND kind='platform' AND id=OLD.id AND conflicted=0;
END;
CREATE TRIGGER ai_undo_settings_update AFTER UPDATE ON settings BEGIN
    UPDATE ai_undo_change SET conflicted=1 WHERE slot=1 AND kind='setting' AND conflicted=0 AND (
        (id='defaultSalaryCents' AND OLD.default_salary_cents IS NOT NEW.default_salary_cents) OR
        (id='warningFloorCents' AND OLD.warning_floor_cents IS NOT NEW.warning_floor_cents));
END;
CREATE TRIGGER ai_undo_override_insert AFTER INSERT ON salary_overrides BEGIN
    UPDATE ai_undo_change SET conflicted=1 WHERE slot=1 AND kind='override' AND id=NEW.month AND conflicted=0;
END;
CREATE TRIGGER ai_undo_override_update AFTER UPDATE ON salary_overrides
WHEN OLD.salary_cents IS NOT NEW.salary_cents OR OLD.month IS NOT NEW.month BEGIN
    UPDATE ai_undo_change SET conflicted=1 WHERE slot=1 AND kind='override' AND id=OLD.month AND conflicted=0;
END;
CREATE TRIGGER ai_undo_override_delete AFTER DELETE ON salary_overrides BEGIN
    UPDATE ai_undo_change SET conflicted=1 WHERE slot=1 AND kind='override' AND id=OLD.month AND conflicted=0;
END;

ALTER TABLE sync_recovery ADD COLUMN created_day TEXT;
ALTER TABLE sync_recovery ADD COLUMN legacy_retention_day TEXT;
UPDATE sync_recovery SET legacy_retention_day=date('now','localtime') WHERE created_day IS NULL;
ALTER TABLE ledger_history_periods ADD COLUMN preview_json TEXT;
CREATE TRIGGER ledger_history_content_changed AFTER UPDATE OF contents ON ledger_history_periods BEGIN
    UPDATE ledger_history_periods SET preview_json=NULL WHERE first_day=NEW.first_day;
END;
CREATE INDEX ledger_history_preview ON ledger_history_periods(first_day,last_day,preview_json);
ALTER TABLE sync_binding ADD COLUMN supports_ai_revert INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_queue ADD COLUMN revert_operation_ids TEXT;
PRAGMA user_version = 8;
