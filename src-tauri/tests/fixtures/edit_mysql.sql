-- Table data and edit fixture (M3-1), MySQL / MariaDB flavor of edit_postgres.sql, loaded
-- statement by statement into a database created for the run. MySQL specifics: TINYINT(1)
-- as the boolean, an ENUM (labels from the column type), a spatial column (shown as WKT,
-- not writable), AUTO_INCREMENT keys read back with LAST_INSERT_ID().

CREATE TABLE kinds (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    flag TINYINT(1),
    small SMALLINT,
    big BIGINT,
    amount DECIMAL(30,10),
    ratio DOUBLE,
    label TEXT,
    code VARCHAR(10),
    raw VARBINARY(100),
    day DATE,
    at_time TIME(6),
    local_at DATETIME(6),
    ref CHAR(36),
    doc JSON,
    mood ENUM('sad', 'ok', 'happy'),
    spot POINT,
    note VARCHAR(50) NOT NULL DEFAULT 'hello',
    created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE composite (
    a INT NOT NULL,
    b VARCHAR(10) NOT NULL,
    value TEXT,
    PRIMARY KEY (a, b)
);

CREATE TABLE `Odd "Table"` (
    id INT NOT NULL PRIMARY KEY,
    `Select` TEXT,
    `two words` TEXT
);

CREATE TABLE items (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(50) NOT NULL,
    qty INT NOT NULL,
    price DECIMAL(10,2) NOT NULL DEFAULT 1,
    total DECIMAL(12,2) AS (qty * price) STORED,
    CONSTRAINT items_sku_key UNIQUE (sku),
    CONSTRAINT items_qty_check CHECK (qty >= 0)
);

CREATE TABLE child (
    id INT NOT NULL PRIMARY KEY,
    item_id INT NOT NULL,
    CONSTRAINT child_item_fkey FOREIGN KEY (item_id) REFERENCES items (id)
);

CREATE TABLE keyless (name TEXT, value INT);

CREATE TABLE uniq (
    code VARCHAR(20) NOT NULL,
    label TEXT,
    CONSTRAINT uniq_code_key UNIQUE (code)
);

CREATE VIEW items_view AS SELECT id, sku FROM items;
