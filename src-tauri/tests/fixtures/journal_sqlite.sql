-- Optimistic concurrency and change journal fixture (M3-6), SQLite flavor of
-- journal_postgres.sql. Declared types only set affinities.

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    balance NUMERIC,
    ratio REAL,
    seen DATETIME,
    raw BLOB,
    note TEXT,
    doc JSON
);
