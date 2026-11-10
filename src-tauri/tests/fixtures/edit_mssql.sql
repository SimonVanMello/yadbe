-- Table data and edit fixture (M2-1, M2-2), SQL Server flavor of edit_postgres.sql, loaded
-- batch by batch into a database created for the run. SQL Server specifics: a rowversion and
-- a sql_variant column (not writable), a `datetime` next to a `datetime2`, and `audited`,
-- whose trigger reports row counts of its own (no SET NOCOUNT) and forbids `OUTPUT`.

CREATE SCHEMA edits;
GO

CREATE TABLE edits.kinds (
    id int IDENTITY(1,1) CONSTRAINT kinds_pkey PRIMARY KEY,
    flag bit,
    small smallint,
    big bigint,
    amount decimal(30,10),
    ratio float,
    label nvarchar(200),
    code varchar(10),
    raw varbinary(max),
    day date,
    at_time time(7),
    local_at datetime2(6),
    old_at datetime,
    at_tz datetimeoffset(7),
    ref uniqueidentifier,
    doc nvarchar(max),
    note nvarchar(50) NOT NULL CONSTRAINT kinds_note_default DEFAULT N'hello',
    version rowversion,
    variant sql_variant
);

CREATE TABLE edits.composite (
    a int NOT NULL,
    b varchar(10) NOT NULL,
    value nvarchar(100),
    CONSTRAINT composite_pkey PRIMARY KEY (a, b)
);

CREATE TABLE edits.[Odd "Table"] (
    id int NOT NULL CONSTRAINT odd_pkey PRIMARY KEY,
    [Select] nvarchar(100),
    [two words] nvarchar(100)
);

CREATE TABLE edits.items (
    id int IDENTITY(1,1) CONSTRAINT items_pkey PRIMARY KEY,
    sku nvarchar(50) NOT NULL CONSTRAINT items_sku_key UNIQUE,
    qty int NOT NULL CONSTRAINT items_qty_check CHECK (qty >= 0),
    price decimal(10,2) NOT NULL CONSTRAINT items_price_default DEFAULT 1,
    total AS (qty * price) PERSISTED
);

CREATE TABLE edits.child (
    id int NOT NULL CONSTRAINT child_pkey PRIMARY KEY,
    item_id int NOT NULL CONSTRAINT child_item_fkey REFERENCES edits.items (id)
);

CREATE TABLE edits.keyless (name nvarchar(50), value int);

CREATE TABLE edits.uniq (
    code nvarchar(20) NOT NULL CONSTRAINT uniq_code_key UNIQUE,
    label nvarchar(50)
);

CREATE TABLE edits.audited (
    id int IDENTITY(1,1) CONSTRAINT audited_pkey PRIMARY KEY,
    name nvarchar(50) NOT NULL
);

CREATE TABLE edits.audit_log (
    id int IDENTITY(1,1) CONSTRAINT audit_log_pkey PRIMARY KEY,
    what nvarchar(50)
);
GO

CREATE VIEW edits.items_view AS SELECT id, sku FROM edits.items;
GO

CREATE TRIGGER edits.audited_log ON edits.audited AFTER INSERT, UPDATE AS
BEGIN
    INSERT INTO edits.audit_log (what) SELECT N'a' UNION ALL SELECT N'b' UNION ALL SELECT N'c';
END;
GO
