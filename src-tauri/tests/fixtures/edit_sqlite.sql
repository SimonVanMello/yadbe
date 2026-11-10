-- Table data and edit fixture (M2-1, M2-2), SQLite flavor of edit_postgres.sql, loaded into
-- a temporary file. Declared types only set affinities: values keep their storage class.

CREATE TABLE kinds (
    id INTEGER PRIMARY KEY,
    flag BOOLEAN,
    small SMALLINT,
    big BIGINT,
    amount NUMERIC(30,10),
    ratio REAL,
    label TEXT,
    code VARCHAR(10),
    raw BLOB,
    day DATE,
    local_at DATETIME,
    ref TEXT,
    doc JSON,
    note TEXT NOT NULL DEFAULT 'hello',
    created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE composite (
    a INTEGER NOT NULL,
    b VARCHAR(10) NOT NULL,
    value TEXT,
    PRIMARY KEY (a, b)
);

CREATE TABLE "Odd ""Table""" ("id" INTEGER PRIMARY KEY, "Select" TEXT, "two words" TEXT);

CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    sku TEXT NOT NULL CONSTRAINT items_sku_key UNIQUE,
    qty INTEGER NOT NULL CONSTRAINT items_qty_check CHECK (qty >= 0),
    price NUMERIC NOT NULL DEFAULT 1,
    total NUMERIC GENERATED ALWAYS AS (qty * price) STORED
);

CREATE TABLE child (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items (id));

CREATE TABLE keyless (name TEXT, value INTEGER);

CREATE TABLE uniq (code TEXT NOT NULL UNIQUE, label TEXT);

CREATE VIEW items_view AS SELECT id, sku FROM items;
