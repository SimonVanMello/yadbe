-- Foreign key navigation fixture (M3-2), SQLite flavor (see `fk_postgres.sql` for the
-- tables). No schemas: `implicit` references `parent` without naming its columns instead.

CREATE TABLE parent (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE
);

CREATE TABLE "Odd ""Parent""" (
    "Key A" INTEGER NOT NULL,
    "key b" TEXT NOT NULL,
    label TEXT,
    PRIMARY KEY ("Key A", "key b")
);

CREATE TABLE child (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES parent (id),
    a INTEGER,
    b TEXT,
    note TEXT,
    FOREIGN KEY (a, b) REFERENCES "Odd ""Parent""" ("Key A", "key b")
);

CREATE TABLE tree (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES tree (id),
    label TEXT
);

CREATE TABLE implicit (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES parent
);

INSERT INTO parent VALUES (1, 'Alice', 'A1'), (2, 'Bruno', 'B2'), (3, '50%_off', 'C3');
INSERT INTO "Odd ""Parent""" VALUES (1, 'x''y', 'first'), (1, 'z', 'second'), (2, 'x''y', 'third');
INSERT INTO child VALUES
    (1, 1, 1, 'x''y', 'one'),
    (2, 1, 1, 'z', 'two'),
    (3, 1, NULL, NULL, 'three'),
    (4, 2, 1, 'x''y', 'four'),
    (5, NULL, 2, 'x''y', 'five');
INSERT INTO tree VALUES (1, NULL, 'root'), (2, 1, 'a'), (3, 1, 'b'), (4, 2, 'c');
INSERT INTO implicit VALUES (1, 1), (2, 3);
