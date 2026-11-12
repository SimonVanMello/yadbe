# MongoDB, Elasticsearch and Redis: preliminary analysis

Status: analysis, nothing implemented. Written after M3 on the code as it stands. It says what the three engines need, what the current architecture gives them for free, what has to change first, and which decisions the product owner has to take before a task is started. The plan that follows from it is milestone M4 in `docs/PLAN.md`.

## 1. Summary

- The three engines are not SQL dialects. Forcing them under `Dialect` would break rule 1 in spirit (every service would test "is this really SQL?"). They need **engine families**: `sql` (today's four), `document` (MongoDB), `search` (Elasticsearch), `keyValue` (Redis).
- About half of yadbe is family-neutral and is reused as is: connections, secrets, SSH tunnels, TLS, sessions, the result store and the grid, history, statement log, journal, tabs, palette, exports. The other half is SQL by construction and stays SQL only: splitter, classifier, dialects, table browsing SQL, edit planner, completion, formatter, plans, import, DDL, Script as, EF Core, .NET connection strings.
- The first task is therefore a **refactor with no new engine**: families in the backend contract and in the front, with the four SQL engines unchanged and their tests green. Each engine then comes as a read task followed by an edit task.
- Order proposed: foundations → MongoDB ∥ Redis → Elasticsearch (it reuses MongoDB's document viewer) → validation.
- Five decisions are open (section 8). The largest is the MongoDB query syntax.

## 2. What the current code gives and what it assumes

| Area | State | For the new engines |
|---|---|---|
| Connection definitions, groups, environment colour, read-only flag, keychain (`db/config.rs`, `secrets/`, `store/`) | neutral, except `Engine` and the host / port / database / user shape | reused; the definition gains per-family fields |
| SSH tunnel (`tunnel/`), TLS identity (`db/tls_identity.rs`) | neutral: a loopback listener, PEM files | reused, with topology limits (section 6) |
| `ConnectionManager`, `ConnectionSession`, keep-alive, link watch, cancel handle | neutral lifecycle around a `dyn Connection` | reused once `Connection` is split (section 3) |
| `Connection::query(sql)`, `execute`, `query_bound`, `execute_params`, `describe_origins`, `explain` (`db/driver.rs`) | SQL text in, columns + rows out | SQL family only |
| `ResultStore`, 500-row windows, sort / filter view, aggregates, grid | tabular, typed by `Value` | reused for anything that can be shown as rows; documents need a second view |
| `Value` (`db/value.rs`) | scalars, `Json(String)`, `Array` | needs BSON types (section 4.2) |
| `MetaNode` / `ObjectRef` (database, schema, name), `TableDetails` (columns, keys, FKs) (`db/meta.rs`) | relational | each family gets its own explorer model |
| `split.rs`, `classify.rs`, `params.rs`, `bound.rs`, `edit_dialect.rs`, `table_sql.rs`, `edit/` | SQL | SQL only; each family has its own read-only classifier and its own edit path |
| History, statement log | a text and an outcome | reused: the "statement" is the command as typed |
| Change journal (`session/journal.rs`, `edit/inverse.rs`) | stores SQL and inverse SQL | the store is reusable if an entry can carry non-SQL operations |
| Exports (`export/`) | from a result or a table | reused for results; JSON Lines of whole documents to add |
| Front: `engine ===` tests | 15 files (connection form, launch, export options, formatter, explain, completion…) | to replace by capabilities before adding engines |
| Backend: `Engine::` outside the drivers | about 30 files, most of them legitimate (dialect lookup, connection-string parsing, importers) | each to review in the foundations task |

## 3. Foundations: engine families

**Backend.** `Engine` gains `Mongodb`, `Elasticsearch`, `Redis` and a `family()`. The `Connection` trait is split:

- `Link`, common to all: `server_version`, `ping`, `keep_alive`, `link`, `cancel_handle`, `close`, read-only switch.
- `SqlConnection: Link`: today's query / execute / bound / explain / introspector / activity methods, unchanged.
- `DocumentConnection`, `SearchConnection`, `KeyValueConnection`: one per family, defined by the engine's task.

A session holds `enum Backend { Sql(..), Document(..), Search(..), KeyValue(..) }`. Dispatch on the **family** at the session and command layer is the sanctioned place; `match engine` stays forbidden outside drivers. SQL services take a `&dyn SqlConnection` and refuse other families with a typed error.

**Capabilities.** `Capabilities` gains `family` and the flags the front needs to stop testing engines: which tab kinds exist (query console, data browser), whether an apply is atomic, whether cancel exists, which authentication fields the form shows. SQL-only features (formatter, explain, import, DDL, Script as, EF, .NET string) become capabilities that the new engines leave off.

**Front.** One query tab shell, with the editor language, the run action and the result view chosen by family. One explorer tree, with the row model given per family. The connection form is built from the capability's field list.

**Commands.** New families get their own command sets (`mongo_*`, `search_*`, `kv_*`) and mock modules. SQL commands do not change, so the 522 backend tests and 404 Playwright tests are the regression net of the refactor.

**Rules to amend in `CLAUDE.md`** (owner approval): rule 2 ("values are bound, identifiers are quoted") becomes "values never travel inside command text built by yadbe" (BSON documents, JSON bodies, RESP arguments are structured, so the rule holds by construction); rule 3 ("user SQL is sent as written") needs a clause for MongoDB (section 4.3); rule 10 needs the non-atomic case (decision 3).

## 4. MongoDB

### 4.1 Connecting

- Crate: `mongodb` (official, async on tokio, rustls). It pulls `bson` and a DNS resolver for `mongodb+srv://`. Sizeable: the installer cost (P-10) is to measure in the foundations of the engine.
- Forms: URI (`mongodb://`, `mongodb+srv://`), or host list + replica set + `authSource` + mechanism (SCRAM, X.509). The password stays in the keychain and is injected at connect time; a pasted URI is split so that the secret never reaches SQLite.
- Topology: the driver discovers replica set members and connects to them directly. Through an SSH tunnel only `directConnection=true` to one host works. To state in the form.

### 4.2 Values

BSON has types JSON does not: ObjectId, Date, Int32 / Int64 / Double / Decimal128, Binary (with subtype), Timestamp, Regex, MinKey / MaxKey. Losing them on a round trip corrupts data (an Int64 rewritten as a Double, a Date as a string).

- `Value` gains `ObjectId(String)`; Date maps to `TimestampTz`, Decimal128 to `Decimal`, Int64 to `Int`, Binary to `Bytes`.
- A nested document or array crosses as `Json` in **canonical Extended JSON v2**, which is lossless. The front shows it relaxed and sends it back canonical.
- A result is shown two ways: **grid** (top-level fields as columns, the union over the loaded window, missing ≠ null) and **documents** (JSON tree). The grid is the existing one.

### 4.3 Query language (decision 1)

MongoDB has no text query language of its own; what people type is mongosh, which is JavaScript. Three options:

1. **Embed a JavaScript engine** and run mongosh syntax. Full compatibility, but a large dependency, a sandbox to secure, and arbitrary code in a tool whose point is safety. Rejected.
2. **Parse a mongosh-like subset**: `db.<coll>.find(filter, projection).sort().skip().limit()`, `aggregate([...])`, `countDocuments`, `distinct`, `insertOne/Many`, `updateOne/Many`, `replaceOne`, `deleteOne/Many`, `createIndex`, `drop`, plus `db.runCommand({...})`; arguments in relaxed JSON with the shell constructors (`ObjectId()`, `ISODate()`, `NumberLong()`, `NumberDecimal()`, regex literals). No variables, no loops, no functions. **Recommended**: it is what users paste from documentation and from Compass, and it parses into typed driver calls.
3. **JSON only**: a form per operation (collection, filter, projection, sort). Simplest, but nothing can be pasted.

With option 2, rule 3 reads: yadbe sends the operation the text denotes, without changing its meaning; the history keeps the text as typed and the statement log the command sent.

### 4.4 Explorer, browsing, editing

- Explorer: databases → collections, views, time series → indexes. A collection's "columns" come from **sampling** (`$sample`, 100–1000 documents): field paths, types seen, how often. It is an estimate and the UI says so.
- Collection tab: filter (JSON), projection, sort, pages by `_id` keyset; estimated count at once (`estimatedDocumentCount`), exact on request.
- Editing: a change is `updateOne({_id, <original values of the changed fields>}, {$set / $unset})`, an insert `insertOne`, a delete `deleteOne({_id, …})`. `matchedCount == 1` is the "exactly one row" check, and the original values give the same conflict detection as SQL. The preview shows those commands.
- Atomicity: multi-document transactions exist only on replica sets and sharded clusters. On a standalone server an apply cannot be atomic (decision 3).
- Read-only: allow-list of commands (`find`, `aggregate` without `$out` / `$merge`, `count`, `distinct`, `list*`, `explain`, `collStats`…); everything else refused in the backend.
- Cancel: `killOp` on the operation, plus `maxTimeMS` for the statement timeout.
- Dangerous: `drop`, `dropDatabase`, `deleteMany({})`, `updateMany` without filter, with the count they would touch.
- Later: explain as a plan tree, JSON import, activity (`currentOp`).

## 5. Elasticsearch

### 5.1 Connecting

- **No client crate**: the API is HTTP + JSON, and `reqwest` (rustls) is already in the lockfile through Tauri. A thin client in `db/drivers/elasticsearch/` keeps the dependency list unchanged and makes **OpenSearch** work with the same code where the APIs agree (decision 4).
- Authentication: basic, API key, bearer token; CA file and client certificate reuse the TLS code. Secrets in the keychain.
- No node sniffing: yadbe talks to the URL it was given, which also makes the SSH tunnel work.

### 5.2 Query language

The Kibana Dev Tools console syntax, which is what every Elasticsearch user knows: a method and a path, then a JSON body (`GET /orders/_search` + body). Several requests per tab, run one at a time or all. The request is sent as written, so rule 3 holds without amendment.

Results: a `_search` response is shown as a hits grid (`_id`, `_score`, `_source` top-level fields) and as raw JSON; aggregations as raw JSON first, as tables later. `POST /_query` (ES|QL) and `/_sql` return real columns and rows and go straight to the grid.

### 5.3 Explorer, browsing, editing

- Explorer: indices (health, docs, size), data streams, aliases, index templates; a mapping gives real field names and types (no sampling needed).
- Index tab: query-string or JSON filter, sort, pages with `search_after` + point in time (never deep `from`), `track_total_hits` on request.
- Editing: by document. `seq_no` + `primary_term` give true optimistic concurrency (`if_seq_no`, `if_primary_term`). `_bulk` is **not atomic** (decision 3). Search is near-real-time: a document just written is not found until the next refresh, so the tab re-reads by id after an apply instead of re-running the search. Data streams are append-only. Recommended first scope: read everything, edit one document at a time (decision 2).
- Read-only: method + path allow-list (`GET`, `HEAD`, and `POST` only on `_search`, `_msearch`, `_count`, `_query`, `_sql`, `_explain`, `_field_caps`, `_analyze`, `_validate`…).
- Cancel: `_tasks/<id>/_cancel`, and dropping the HTTP request.
- Dangerous: `DELETE /<index>` (wildcards above all), `_delete_by_query`, `_update_by_query`, `_reindex`, closing an index.

## 6. Redis

### 6.1 Connecting

- Crate: `redis` (redis-rs: async on tokio, rustls, RESP3; cluster and sentinel behind features). Small.
- Authentication: password or ACL user + password, TLS with CA / client certificate, database index. Works with **Valkey** unchanged (decision 4).
- Topologies (decision 5): standalone first. Cluster needs redirection handling and cannot go through one SSH tunnel; Sentinel needs a discovery step.

### 6.2 Console

A command line as in `redis-cli` (`HGETALL user:42`), tokenized with its quoting rules and sent as RESP arguments: as written, nothing concatenated. Replies are scalars, lists or maps: shown as a small grid or tree. `MONITOR`, `SUBSCRIBE` and blocking commands need a streaming view: later.

### 6.3 Explorer, browsing, editing

- Explorer: databases (`db0`…) → keys grouped by a delimiter (`:` by default) into a virtual tree. Keys are listed with **`SCAN` only**, in batches, cancellable; `KEYS` is never issued by yadbe and is a confirmed dangerous command in the console (it blocks a production server). Type, TTL and memory are read per visible row (`TYPE`, `TTL`, `MEMORY USAGE`), not for the whole keyspace.
- Key tab, one viewer per type: string (text / JSON / hex), hash, list, set, sorted set, stream; RedisJSON when the module is there. Large collections are paged with `HSCAN` / `SSCAN` / `ZSCAN` / `LRANGE`.
- Editing: per type, buffered and previewed as the commands to run. `WATCH` + `MULTI` / `EXEC` gives an atomic apply with conflict detection (the transaction aborts if the key changed), so rule 10 holds fully here. TTL edit, rename, delete.
- Read-only: the server says which commands write (`COMMAND INFO` flags), so the classifier is authoritative, not a list yadbe maintains; `EVAL` and friends are refused in read-only.
- Cancel: none for a running command (`native_cancel = false`); scans stop between batches.
- Dangerous: `FLUSHALL`, `FLUSHDB`, `KEYS`, `DEL` / `UNLINK` on many keys, `CONFIG SET`, `SHUTDOWN`, `DEBUG`.

## 7. Cross-cutting

- **History, statement log, palette, tabs, restore**: reused. A restored tab never connects by itself, as today.
- **Journal and revert**: an entry must carry family-specific operations and their inverses (a `$set` back to the original values, a `SET` back to the old value). The inverse of a delete needs the full document or value captured before the apply. Store migration needed.
- **Completion**: per family and later than the first version of each engine: collection and field names (sampled) for MongoDB, API paths and mapping fields for Elasticsearch, command names and arguments for Redis.
- **Exports**: results go through the existing encoders; add JSON Lines of whole documents (MongoDB, Elasticsearch).
- **Tests**: `dev/compose.yml` gains MongoDB (a single-node replica set, so transactions are testable, and a standalone one), Elasticsearch single-node (about 1 GB of RAM: started on demand) and Redis. Variables `YADBE_TEST_MONGO_URL`, `YADBE_TEST_ES_URL`, `YADBE_TEST_REDIS_URL`, skipped when unset. The SQL conformance suite does not apply; each family gets its own (types round trip, read-only refusals, edits checked against the resulting state, cancellation where it exists).
- **Licences**: `mongodb` and `bson` Apache-2.0, `redis` BSD-3; all compatible. The servers' licences (SSPL, AGPL / ELv2, RSALv2) do not concern a client.
- **Size and startup**: three engines add backend code and three editor modes. The front parts are lazy-loaded with the mechanism of M3-17 (`src/app/lazyModule.ts`); the installer size is measured per engine.

### Risks

1. **The foundations refactor touches the centre of the backend.** Mitigation: no behaviour change, the existing suites as the net, and it lands alone before any engine.
2. **The mongosh subset is a language to maintain.** Users will type things outside it. Mitigation: a precise error saying what is supported, and `db.runCommand` as the escape hatch.
3. **Non-atomic applies** weaken the product's main safety promise on two engines. Mitigation in decision 3.
4. **Sampled schemas are wrong by nature** (a field present in 1 document out of 10 000). The UI must show them as estimates.
5. **Scope**: three engines, each with read and edit, is of the order of the whole of M2 + part of M3. Splitting by engine keeps each deliverable usable on its own.

## 8. Decisions for the product owner

1. **MongoDB query syntax**: mongosh-like subset parsed by yadbe (recommended), or JSON forms only.
2. **Editing scope of the first version**: recommended MongoDB full (cells, insert, delete), Redis full (per type), Elasticsearch one document at a time; bulk and by-query writes only through the console.
3. **Applies that cannot be atomic** (MongoDB standalone, Elasticsearch): recommended to allow them, labelled "applied one by one, not atomic" in the preview, each operation checked (one document matched, original values / sequence number), stopping at the first failure, with the journal recording what was applied so that it can be reverted. The alternative is to refuse multi-document applies on those servers.
4. **Compatible servers**: OpenSearch and Valkey supported and tested in compose (recommended: yes for Valkey, which costs nothing; OpenSearch yes but only where its API equals Elasticsearch's), or left to chance.
5. **Topologies in the first version**: recommended MongoDB replica sets and `mongodb+srv` yes (the driver does it), Redis standalone only (Cluster and Sentinel later), Elasticsearch single URL.

Also to confirm: milestone name and order (M4, MongoDB ∥ Redis then Elasticsearch), and the amendment of rules 2, 3 and 10 in `CLAUDE.md`.
