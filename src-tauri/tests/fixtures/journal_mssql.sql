-- Optimistic concurrency and change journal fixture (M3-6), SQL Server flavor of
-- journal_postgres.sql: `ntext` and `xml` have no `=` (compared through their text), a
-- `datetime` next to a `datetime2`, a row version (left to the server by a revert), and an
-- IDENTITY written back with IDENTITY_INSERT.

CREATE SCHEMA journal;
GO

CREATE TABLE journal.accounts (
    id int IDENTITY(1,1) CONSTRAINT accounts_pkey PRIMARY KEY,
    name nvarchar(100) NOT NULL,
    balance decimal(14,4),
    ratio float,
    seen datetime2(6),
    old_seen datetime,
    raw varbinary(max),
    note nvarchar(max),
    legacy ntext,
    doc xml,
    version rowversion
);
