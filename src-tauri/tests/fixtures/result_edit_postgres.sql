-- Editable query results fixture (M3-7), PostgreSQL flavor. `{s}` is the schema created for
-- the run. `items` has a key and columns the results leave out (a revert of a deleted row
-- needs them); `pairs` a composite key; `tags` no key; `item_names` is a view.

CREATE TABLE {s}.items (
    id integer PRIMARY KEY,
    name text NOT NULL,
    price numeric(10,2),
    note text,
    created timestamp(3) NOT NULL DEFAULT '2025-01-02 03:04:05.678'
);
CREATE TABLE {s}.pairs (a integer, b integer, label text, PRIMARY KEY (a, b));
CREATE TABLE {s}.tags (name text);
CREATE VIEW {s}.item_names AS SELECT id, name FROM {s}.items;
INSERT INTO {s}.items (id, name, price, note) VALUES
    (1, 'one', 1.50, 'first'), (2, 'two', 2.50, NULL), (3, 'three', 3.50, 'third'),
    (4, 'four', 4.50, 'fourth');
INSERT INTO {s}.pairs VALUES (1, 1, 'a'), (1, 2, 'b');
INSERT INTO {s}.tags VALUES ('x'), ('x');
