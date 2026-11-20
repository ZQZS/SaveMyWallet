CREATE TABLE platforms (
    id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(name) BETWEEN 1 AND 40)
);

CREATE TABLE entries (
    id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    platform_id TEXT NOT NULL REFERENCES platforms(id),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
    month TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 99999999900),
    status TEXT NOT NULL CHECK(status IN ('due', 'paid', 'estimated')),
    kind TEXT NOT NULL CHECK(kind IN ('single', 'installment', 'estimate')),
    installment_index INTEGER,
    installment_count INTEGER,
    CHECK(status <> 'estimated' OR kind = 'estimate'),
    CHECK(
        (kind = 'installment' AND installment_index IS NOT NULL AND installment_count IS NOT NULL
         AND installment_count BETWEEN 1 AND 120 AND installment_index BETWEEN 1 AND installment_count)
        OR (kind <> 'installment' AND installment_index IS NULL AND installment_count IS NULL)
    )
);
CREATE INDEX entries_month_platform ON entries(month, platform_id);

CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    default_salary_cents INTEGER NOT NULL CHECK(default_salary_cents BETWEEN 0 AND 99999999900),
    warning_floor_cents INTEGER NOT NULL CHECK(warning_floor_cents BETWEEN 0 AND 99999999900)
);
CREATE TABLE salary_overrides (
    month TEXT NOT NULL PRIMARY KEY,
    salary_cents INTEGER NOT NULL CHECK(salary_cents BETWEEN 0 AND 99999999900)
);

PRAGMA user_version = 1;
