-- Editable query results fixture (M3-7), MySQL flavor of result_edit_postgres.sql.

CREATE TABLE items (
    id INT NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2),
    note TEXT,
    created DATETIME(3) NOT NULL DEFAULT '2025-01-02 03:04:05.678'
);
CREATE TABLE pairs (a INT NOT NULL, b INT NOT NULL, label VARCHAR(10), PRIMARY KEY (a, b));
CREATE TABLE tags (name VARCHAR(10));
CREATE VIEW item_names AS SELECT id, name FROM items;
INSERT INTO items (id, name, price, note) VALUES
    (1, 'one', 1.50, 'first'), (2, 'two', 2.50, NULL), (3, 'three', 3.50, 'third'),
    (4, 'four', 4.50, 'fourth');
INSERT INTO pairs VALUES (1, 1, 'a'), (1, 2, 'b');
INSERT INTO tags VALUES ('x'), ('x');
