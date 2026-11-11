-- Foreign key navigation fixture (M3-2), MySQL / MariaDB flavor, in a database created for
-- the run (see `fk_postgres.sql` for the tables). Databases are MySQL's namespaces: `remote`
-- lives in a second database `{db2}` and references `parent` of `{db}` across databases.

CREATE TABLE parent (
    id INT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(10) UNIQUE
);

CREATE TABLE `Odd "Parent"` (
    `Key A` INT NOT NULL,
    `key b` VARCHAR(10) NOT NULL,
    label VARCHAR(100),
    PRIMARY KEY (`Key A`, `key b`)
);

CREATE TABLE child (
    id INT PRIMARY KEY,
    parent_id INT,
    a INT,
    b VARCHAR(10),
    note VARCHAR(100),
    CONSTRAINT child_parent_fkey FOREIGN KEY (parent_id) REFERENCES parent (id),
    CONSTRAINT child_odd_fkey FOREIGN KEY (a, b) REFERENCES `Odd "Parent"` (`Key A`, `key b`)
);

CREATE TABLE tree (
    id INT PRIMARY KEY,
    parent_id INT,
    label VARCHAR(100),
    CONSTRAINT tree_parent_fkey FOREIGN KEY (parent_id) REFERENCES tree (id)
);

CREATE TABLE {db2}.remote (
    id INT PRIMARY KEY,
    parent_id INT,
    CONSTRAINT remote_parent_fkey FOREIGN KEY (parent_id) REFERENCES {db}.parent (id)
);

INSERT INTO parent VALUES (1, 'Alice', 'A1'), (2, 'Bruno', 'B2'), (3, '50%_off', 'C3');
INSERT INTO `Odd "Parent"` VALUES (1, 'x''y', 'first'), (1, 'z', 'second'), (2, 'x''y', 'third');
INSERT INTO child VALUES
    (1, 1, 1, 'x''y', 'one'),
    (2, 1, 1, 'z', 'two'),
    (3, 1, NULL, NULL, 'three'),
    (4, 2, 1, 'x''y', 'four'),
    (5, NULL, 2, 'x''y', 'five');
INSERT INTO tree VALUES (1, NULL, 'root'), (2, 1, 'a'), (3, 1, 'b'), (4, 2, 'c');
INSERT INTO {db2}.remote VALUES (1, 1), (2, 3);
