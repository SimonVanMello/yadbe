-- Small SQLite fixture: one table per storage class and declared-type family.
CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10, 2),
    ratio REAL,
    data BLOB,
    active BOOLEAN,
    created_at DATETIME
);
INSERT INTO items VALUES (1, 'first', 12.5, 0.25, x'00ff', 1, '2025-01-02 03:04:05');
INSERT INTO items VALUES (2, 'second', NULL, NULL, NULL, 0, NULL);
INSERT INTO items VALUES (9223372036854775807, 'max', 1, 1e300, x'', 1, '2025-12-31');
