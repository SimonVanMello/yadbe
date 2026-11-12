-- Editable query results fixture (M3-7), SQLite flavor of result_edit_postgres.sql.

CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC,
    note TEXT,
    created DATETIME NOT NULL DEFAULT '2025-01-02 03:04:05.678'
);
CREATE TABLE pairs (a INTEGER, b INTEGER, label TEXT, PRIMARY KEY (a, b));
CREATE TABLE tags (name TEXT);
CREATE VIEW item_names AS SELECT id, name FROM items;
INSERT INTO items (id, name, price, note) VALUES
    (1, 'one', 1.50, 'first'), (2, 'two', 2.50, NULL), (3, 'three', 3.50, 'third'),
    (4, 'four', 4.50, 'fourth');
INSERT INTO pairs VALUES (1, 1, 'a'), (1, 2, 'b');
INSERT INTO tags VALUES ('x'), ('x');
