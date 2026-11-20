ALTER TABLE entries ADD COLUMN voided INTEGER NOT NULL DEFAULT 0 CHECK(voided IN (0, 1));

-- Active entries keep their original JSON shape for pending requests and existing sync shadows.
DROP VIEW sync_local;
CREATE VIEW sync_local(kind, id, value_json) AS
 SELECT 'platform', id, json_object('id', id, 'name', name) FROM platforms
 UNION ALL SELECT 'entry', id, CASE WHEN voided THEN json_set(entry_json, '$.voided', json('true')) ELSE entry_json END
 FROM (
    SELECT id, voided, json_object(
        'id', id, 'platformId', platform_id, 'title', title, 'month', month,
        'amountCents', amount_cents, 'status', status, 'kind', kind,
        'installmentIndex', installment_index, 'installmentCount', installment_count) AS entry_json
    FROM entries)
 UNION ALL SELECT 'setting', 'defaultSalaryCents', CAST(default_salary_cents AS TEXT) FROM settings
 UNION ALL SELECT 'setting', 'warningFloorCents', CAST(warning_floor_cents AS TEXT) FROM settings
 UNION ALL SELECT 'override', month, CAST(salary_cents AS TEXT) FROM salary_overrides;
PRAGMA user_version = 4;
