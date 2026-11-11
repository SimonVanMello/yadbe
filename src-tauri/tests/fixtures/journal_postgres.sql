-- Optimistic concurrency and change journal fixture (M3-6), PostgreSQL flavor. `{s}` is the
-- schema created for the run. `accounts` has a value of each kind the checks compare
-- (decimal, float, timestamp, binary, NULL), a `json` column (no equality operator: compared
-- through its text) and a `point` (an extension-like type read as text), and an identity the
-- server always generates (written back with OVERRIDING SYSTEM VALUE by a revert).

CREATE TABLE {s}.accounts (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    balance numeric(14,4),
    ratio double precision,
    seen timestamp(6),
    raw bytea,
    note text,
    doc json,
    spot point
);
