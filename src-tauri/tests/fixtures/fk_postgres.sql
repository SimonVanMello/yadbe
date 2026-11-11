-- Foreign key navigation fixture (M3-2), PostgreSQL flavor. `{s}` and `{s2}` are the schemas
-- created for the run (dropped afterwards). Same logical tables on every engine: `parent`
-- (single key, a unique code), `Odd "Parent"` (composite key with odd identifiers), `child`
-- (one foreign key to each), `tree` (self-reference); here also `{s2}.remote`, a foreign key
-- from another schema.

CREATE TABLE {s}.parent (
    id integer PRIMARY KEY,
    name text NOT NULL,
    code varchar(10) UNIQUE
);

CREATE TABLE {s}."Odd ""Parent""" (
    "Key A" integer NOT NULL,
    "key b" varchar(10) NOT NULL,
    label text,
    PRIMARY KEY ("Key A", "key b")
);

CREATE TABLE {s}.child (
    id integer PRIMARY KEY,
    parent_id integer REFERENCES {s}.parent (id),
    a integer,
    b varchar(10),
    note text,
    CONSTRAINT child_odd_fkey FOREIGN KEY (a, b) REFERENCES {s}."Odd ""Parent""" ("Key A", "key b")
);

CREATE TABLE {s}.tree (
    id integer PRIMARY KEY,
    parent_id integer REFERENCES {s}.tree (id),
    label text
);

CREATE TABLE {s2}.remote (
    id integer PRIMARY KEY,
    parent_id integer REFERENCES {s}.parent (id)
);

INSERT INTO {s}.parent VALUES (1, 'Alice', 'A1'), (2, 'Bruno', 'B2'), (3, '50%_off', 'C3');
INSERT INTO {s}."Odd ""Parent""" VALUES (1, 'x''y', 'first'), (1, 'z', 'second'), (2, 'x''y', 'third');
INSERT INTO {s}.child VALUES
    (1, 1, 1, 'x''y', 'one'),
    (2, 1, 1, 'z', 'two'),
    (3, 1, NULL, NULL, 'three'),
    (4, 2, 1, 'x''y', 'four'),
    (5, NULL, 2, 'x''y', 'five');
INSERT INTO {s}.tree VALUES (1, NULL, 'root'), (2, 1, 'a'), (3, 1, 'b'), (4, 2, 'c');
INSERT INTO {s2}.remote VALUES (1, 1), (2, 3);
