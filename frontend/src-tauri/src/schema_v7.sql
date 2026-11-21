-- Device-local recovery metadata. These tables are outside the ledger export and sync views.
CREATE TABLE IF NOT EXISTS ledger_history_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    open_day TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_history_periods (
    first_day TEXT PRIMARY KEY NOT NULL,
    last_day TEXT NOT NULL CHECK (last_day >= first_day),
    contents TEXT NOT NULL
);
PRAGMA user_version = 7;
