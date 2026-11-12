-- Editable query results fixture (M3-7), SQL Server flavor of result_edit_postgres.sql.

CREATE SCHEMA re;
GO

CREATE TABLE re.items (
    id int CONSTRAINT items_pkey PRIMARY KEY,
    name nvarchar(100) NOT NULL,
    price decimal(10,2),
    note nvarchar(max),
    created datetime2(3) NOT NULL DEFAULT '2025-01-02 03:04:05.678'
);
CREATE TABLE re.pairs (a int, b int, label nvarchar(10), CONSTRAINT pairs_pkey PRIMARY KEY (a, b));
CREATE TABLE re.tags (name nvarchar(10));
GO

CREATE VIEW re.item_names AS SELECT id, name FROM re.items;
GO

INSERT INTO re.items (id, name, price, note) VALUES
    (1, N'one', 1.50, N'first'), (2, N'two', 2.50, NULL), (3, N'three', 3.50, N'third'),
    (4, N'four', 4.50, N'fourth');
INSERT INTO re.pairs VALUES (1, 1, N'a'), (1, 2, N'b');
INSERT INTO re.tags VALUES (N'x'), (N'x');
