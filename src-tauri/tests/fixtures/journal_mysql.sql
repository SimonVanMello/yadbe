-- Optimistic concurrency and change journal fixture (M3-6), MySQL flavor of
-- journal_postgres.sql: a `JSON` column (compared through JSON_EXTRACT) and a single-precision
-- `FLOAT` (not compared: MySQL compares it as a double).

CREATE TABLE accounts (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    balance DECIMAL(14,4),
    ratio DOUBLE,
    seen DATETIME(6),
    raw VARBINARY(100),
    note TEXT,
    doc JSON,
    small_ratio FLOAT
);
