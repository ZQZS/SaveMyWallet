-- Rebuild the v5 entries table to allow a fully deposited estimate to have no remainder.
DROP VIEW sync_local;
CREATE TABLE entries_v6 (
    id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    platform_id TEXT NOT NULL REFERENCES platforms(id),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
    month TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 0 AND 99999999900),
    status TEXT NOT NULL CHECK(status IN ('due', 'paid', 'estimated')),
    kind TEXT NOT NULL CHECK(kind IN ('single', 'installment', 'estimate')),
    installment_index INTEGER,
    installment_count INTEGER,
    voided INTEGER NOT NULL DEFAULT 0 CHECK(voided IN (0, 1)),
    installment_id TEXT CHECK(installment_id IS NULL OR (kind = 'installment'
        AND length(installment_id) = 32 AND installment_id NOT GLOB '*[^0-9a-f]*')),
    deposit_cents INTEGER NOT NULL DEFAULT 0 CHECK(deposit_cents BETWEEN 0 AND 99999999900),
    CHECK(kind = 'estimate' OR deposit_cents = 0),
    CHECK(amount_cents + deposit_cents BETWEEN 1 AND 99999999900),
    CHECK(amount_cents > 0 OR status <> 'due'),
    CHECK(status <> 'estimated' OR kind = 'estimate'),
    CHECK(
        (kind = 'installment' AND installment_index IS NOT NULL AND installment_count IS NOT NULL
         AND installment_count BETWEEN 1 AND 120 AND installment_index BETWEEN 1 AND installment_count)
        OR (kind <> 'installment' AND installment_index IS NULL AND installment_count IS NULL)
    )
);
INSERT INTO entries_v6 (rowid, id, platform_id, title, month, amount_cents, status, kind,
    installment_index, installment_count, voided, installment_id)
SELECT rowid, id, platform_id, title, month, amount_cents, status, kind,
    installment_index, installment_count, voided, installment_id FROM entries;
DROP TABLE entries;
ALTER TABLE entries_v6 RENAME TO entries;
CREATE INDEX entries_month_platform ON entries(month, platform_id);
CREATE UNIQUE INDEX entries_installment_period ON entries(installment_id, installment_index)
    WHERE installment_id IS NOT NULL;

CREATE VIEW sync_local(kind, id, value_json) AS
 SELECT 'platform', id, json_object('id', id, 'name', name) FROM platforms
 UNION ALL SELECT 'entry', id, json_patch(
    json_object('id', id, 'platformId', platform_id, 'title', title, 'month', month,
        'amountCents', amount_cents, 'status', status, 'kind', kind,
        'installmentIndex', installment_index, 'installmentCount', installment_count),
    json_object('voided', json(CASE WHEN voided THEN 'true' ELSE 'null' END),
        'installmentId', installment_id, 'depositCents', nullif(deposit_cents, 0))) FROM entries
 UNION ALL SELECT 'setting', 'defaultSalaryCents', CAST(default_salary_cents AS TEXT) FROM settings
 UNION ALL SELECT 'setting', 'warningFloorCents', CAST(warning_floor_cents AS TEXT) FROM settings
 UNION ALL SELECT 'override', month, CAST(salary_cents AS TEXT) FROM salary_overrides;
PRAGMA user_version = 6;
