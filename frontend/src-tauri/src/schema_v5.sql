ALTER TABLE entries ADD COLUMN installment_id TEXT
    CHECK(installment_id IS NULL OR (kind = 'installment' AND length(installment_id) = 32
        AND installment_id NOT GLOB '*[^0-9a-f]*'));
CREATE UNIQUE INDEX entries_installment_period ON entries(installment_id, installment_index)
    WHERE installment_id IS NOT NULL;

DROP VIEW sync_local;
CREATE VIEW sync_local(kind, id, value_json) AS
 SELECT 'platform', id, json_object('id', id, 'name', name) FROM platforms
 UNION ALL SELECT 'entry', id, json_patch(
    json_object('id', id, 'platformId', platform_id, 'title', title, 'month', month,
        'amountCents', amount_cents, 'status', status, 'kind', kind,
        'installmentIndex', installment_index, 'installmentCount', installment_count),
    -- A null merge-patch field is omitted, preserving the wire shape of older rows.
    json_object('voided', json(CASE WHEN voided THEN 'true' ELSE 'null' END),
        'installmentId', installment_id)) FROM entries
 UNION ALL SELECT 'setting', 'defaultSalaryCents', CAST(default_salary_cents AS TEXT) FROM settings
 UNION ALL SELECT 'setting', 'warningFloorCents', CAST(warning_floor_cents AS TEXT) FROM settings
 UNION ALL SELECT 'override', month, CAST(salary_cents AS TEXT) FROM salary_overrides;
PRAGMA user_version = 5;
