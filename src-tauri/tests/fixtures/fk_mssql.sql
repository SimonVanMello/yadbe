-- Foreign key navigation fixture (M3-2), SQL Server flavor, in a database created for the
-- run: schemas `fk` and `fk2` (see `fk_postgres.sql` for the tables).

CREATE SCHEMA fk;
GO
CREATE SCHEMA fk2;
GO

CREATE TABLE fk.parent (
    id int PRIMARY KEY,
    name nvarchar(100) NOT NULL,
    code varchar(10) UNIQUE
);

CREATE TABLE fk.[Odd "Parent"] (
    [Key A] int NOT NULL,
    [key b] nvarchar(10) NOT NULL,
    label nvarchar(100),
    PRIMARY KEY ([Key A], [key b])
);

CREATE TABLE fk.child (
    id int PRIMARY KEY,
    parent_id int REFERENCES fk.parent (id),
    a int,
    b nvarchar(10),
    note nvarchar(100),
    CONSTRAINT child_odd_fkey FOREIGN KEY (a, b) REFERENCES fk.[Odd "Parent"] ([Key A], [key b])
);

CREATE TABLE fk.tree (
    id int PRIMARY KEY,
    parent_id int REFERENCES fk.tree (id),
    label nvarchar(100)
);

CREATE TABLE fk2.remote (
    id int PRIMARY KEY,
    parent_id int REFERENCES fk.parent (id)
);

INSERT INTO fk.parent VALUES (1, N'Alice', 'A1'), (2, N'Bruno', 'B2'), (3, N'50%_off', 'C3');
INSERT INTO fk.[Odd "Parent"] VALUES (1, N'x''y', N'first'), (1, N'z', N'second'), (2, N'x''y', N'third');
INSERT INTO fk.child VALUES
    (1, 1, 1, N'x''y', N'one'),
    (2, 1, 1, N'z', N'two'),
    (3, 1, NULL, NULL, N'three'),
    (4, 2, 1, N'x''y', N'four'),
    (5, NULL, 2, N'x''y', N'five');
INSERT INTO fk.tree VALUES (1, NULL, N'root'), (2, 1, N'a'), (3, 1, N'b'), (4, 2, N'c');
INSERT INTO fk2.remote VALUES (1, 1), (2, 3);
