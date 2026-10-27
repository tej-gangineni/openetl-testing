# Contract (v1)

Three parts are built in parallel against this file. Do not change it without telling the orchestrator.
Runtime: Node >= 22.5, ES modules, **no npm dependencies** for the backend (use `node:sqlite`, `node:http`, `node:child_process`). The web app (`web/`) uses Vite + React.

## Folders and owners
| Path | Owner |
|---|---|
| `src/config.js`, `src/engine.js`, `src/scheduler.js`, `src/store.js`, `src/scenarios.js`, `src/template.js`, `src/server.js`, `src/cli.js`, `package.json`, `test/engine.test.js` | **Engine agent** |
| `src/actions/*`, `scenarios/*.json`, `test/actions.test.js` | **Actions agent** |
| `web/*` | **Web agent** |

## Scenario file (`scenarios/<id>.json`)
```json
{
  "id": "S01-pg-books-ingest",
  "title": "Postgres: books load matches the source",
  "tracker_row": "r047",
  "tags": ["lab", "postgres", "baseline"],
  "resources": ["postgres:lab"],
  "steps": [
    { "id": "empty", "phase": "prepare", "title": "Empty the books table",
      "action": "pg.dropTable", "args": { "table": "books" } },
    { "id": "src", "phase": "prepare", "title": "Count source files",
      "action": "fs.countFiles", "args": { "dir": "${lab}/downloads/books", "glob": "*.txt" }, "save": "srcFiles" },
    { "id": "run", "phase": "trigger", "title": "Run the pipeline",
      "action": "openetl.jobRun", "args": { "pipeline": "${lab}/pipelines/pg_books.toml", "cwd": "${lab}", "extras": ["postgres"] }, "save": "run" },
    { "id": "status", "phase": "observe", "title": "Run finished clean",
      "action": "check.compare", "args": { "left": "${run.status}", "op": "eq", "right": "COMPLETED" } }
  ]
}
```
- `phase` is one of `prepare | trigger | observe | verify`.
- `resources`: names of shared databases or services. The scheduler never runs two scenarios that share a resource at the same time.
- `args` strings may contain `${name}` or `${a.b}`. A string that is exactly one `${...}` keeps the value's type (number, object). Built-in variables: `lab`, `repo`. `save` stores an action's returned `value` under that name for later steps.

## Action interface (`src/actions/index.js` default-exports a map `{ "pg.dropTable": fn, ... }`)
```js
async function action(args, ctx) -> { ok?: boolean, value?: any, evidence?: object }
// ctx = { log(line: string), vars: object, config: object, signal: AbortSignal }
```
- `ok: false` (or omitted `ok` is treated as true) means the check failed: verdict **Fail**.
- Throwing means the step could not run (database down, command missing): verdict **Blocked**.
- `evidence` is a small JSON object shown in the UI (e.g. `{ left: 1997, op: "eq", right: 1997 }`, `{ sql, rows }`). Keep it under 8 KB.
- Required actions: `pg.dropTable`, `pg.scalar`, `pg.rows`, `fs.countFiles`, `openetl.jobRun`, `check.compare` (ops `eq ne gt gte lt lte contains`).
- Safety: only the container names in `config.allowedContainers`; table names must match `/^[a-z_][a-z0-9_]*$/`; SQL for `pg.scalar`/`pg.rows` must be a single SELECT.

## Config (`src/config.js` exports)
`{ lab, repo, allowedContainers: ["openetl-lab-postgres","openetl-lab-mongodb","openetl-lab-clickhouse","openetl-lab-elasticsearch","openetl-lab-qdrant"], pg: { container: "openetl-lab-postgres", user: "lab", db: "openetl" }, port: 4100 }`
`lab` = `../openetl-data-lab`, `repo` = `../openetl` relative to this repo (env `OPENETL_LAB`, `OPENETL_REPO` override).

## Events (one JSON object each; same shape in the CLI, SSE and the store)
```json
{ "runId": "r_20261027_ab12", "seq": 7, "ts": "2026-10-27T12:00:00.000Z", "type": "step.end",
  "stepId": "status", "phase": "observe", "state": "pass", "evidence": {"left":"COMPLETED","op":"eq","right":"COMPLETED"} }
```
`type` values:
- `run.start`: adds `scenario: { id, title, tracker_row, tags, steps: [{ id, phase, title }] }`
- `step.start`: `stepId, phase, title`
- `step.log`: `stepId, line` (one output line; engine may batch nothing, one event per line)
- `step.end`: `stepId, state` (`pass | fail | blocked`), optional `evidence`, optional `error` (string), `ms`
- `run.end`: `verdict` (`Pass | Fail | Blocked`), `counts: { pass, fail, blocked, skipped }`, `ms`
After a step ends `blocked`, every later step gets `step.end` with `state: "skipped"` (no `step.start`). A `fail` does not stop the run.

## HTTP API (`src/server.js`, 127.0.0.1:4100, CORS allowed for `http://127.0.0.1:5173` and `http://localhost:5173`)
- `GET /api/scenarios?tag=&q=` → `{ scenarios: [{ id, title, tracker_row, tags, resources, stepCount, lastRun: {runId, verdict, ts}|null }] }`
- `POST /api/runs` body `{ scenarioId }` → `202 { runId }` (queued through the scheduler)
- `GET /api/runs?scenarioId=&limit=50` → `{ runs: [{ runId, scenarioId, verdict|null, startedAt, endedAt|null }] }`
- `GET /api/runs/:runId` → `{ run: {...}, events: [event, ...] }`
- `GET /api/runs/:runId/events` → Server-Sent Events: replays stored events first, then live ones, then closes after `run.end`. Each message is `data: <event json>`.
- `GET /api/health` → `{ ok: true }`
Errors: `{ "error": "plain sentence" }` with 400/404/500.

## Scheduler rules
Concurrency default 1 (`TEST_CONCURRENCY`). A scenario waits while any of its `resources` is held. FIFO order. A scenario has a 10 minute total timeout, aborting via `ctx.signal` and ending the run `Blocked`.

## Store (`data/results.db`, node:sqlite)
`runs(run_id PK, scenario_id, verdict, started_at, ended_at)`, `events(run_id, seq, ts, type, step_id, json)`. `data/` is gitignored.

---

# Contract v2 (adds what is really happening; everything above still holds)

The v1 screen showed only step titles and pass/fail. v2 makes every step show its real input and output.

## Scenario additions
```json
{
  "summary": "Loads 8 Gutenberg books into Postgres and proves the table matches the source files.",
  "flow": {
    "source": { "kind": "files",    "label": "8 book .txt files", "detail": "${lab}/downloads/books" },
    "engine": { "label": "openetl job run pg_books" },
    "target": { "kind": "postgres", "label": "Postgres table books", "detail": "openetl-lab-postgres:5433/openetl" }
  },
  "steps": [ { "id": "run", "explain": "Runs the real pipeline. Everything below checks what it produced.", "always": false, "...": "as v1" } ]
}
```
- `summary` (plain English, one or two sentences) and `flow` (three boxes: source, engine, target; `kind` is one of `files | http | postgres | mongodb | clickhouse | elasticsearch | qdrant | relata | docker`) are required for every scenario.
- `explain` (one plain sentence: why this step exists) is required for every step.
- `always: true` marks a cleanup step. It runs even after a step ended `blocked` (for example restart a container that a fault step stopped). Its `fail` or `blocked` still counts in the verdict.

## Action result addition
`{ ok?, value?, evidence?, io? }` where `io` is the real traffic of the step:
```json
{ "kind": "sql", "request": { "target": "openetl-lab-postgres", "text": "SELECT count(*) FROM books" },
  "response": { "columns": ["count"], "rows": [[1997]], "rowCount": 1, "truncated": false } }
```
- `kind`: `command | sql | http | fs | docker | compare`.
- `request`: `command` -> `{ text: "uv run ... openetl job run ...", cwd }`; `sql` -> `{ target, text }`; `http` -> `{ method, url, headers (secrets replaced by "***"), body }`; `fs` -> `{ path, glob }`; `docker` -> `{ container, op }`; `compare` -> `{ left, op, right }`.
- `response`: tabular data as `{ columns, rows, rowCount, truncated }` (max 20 rows, each cell cut at 200 characters), or for `http` `{ status, body }` (body cut at 4 KB), or for `command` `{ exitCode, summary }` where `summary` is the parsed result object, or for `docker` `{ ok, state }`.
- Whole `io` object under 8 KB.

## Event additions
- `step.start` now also carries `explain`.
- New `step.io`: `{ type: "step.io", stepId, io }` emitted once per step, before its `step.end`, if the action returned `io`.
- `step.log` gains `level`: `"info"` (default) or `"detail"`. OpenETL output lines that contain `[SUBSTEP]` are `detail`; the UI hides detail lines by default.
- `run.start.scenario` now also carries `summary`, `flow`, and per-step `explain` and `always`.
- `run.end` may carry `note` (string), e.g. "interrupted".

## Before and after
A scenario shows what changed in the database by running the same read action before and after the trigger step (for example a `pg.rows` step in `prepare` and another in `verify`), each with `io`. The UI pairs them by a shared `compareKey` field on the step (`"compareKey": "books-sample"`): steps with the same key and `phase` prepare vs verify are shown side by side as Before / After.

## Interrupted-run sweep (fix)
Add `runs.pid`. The startup sweep closes only runs whose `pid` is no longer alive. Never close a run owned by a live process.

## The 5 scenarios (ids fixed)
| id | tracker row | what it proves | target |
|---|---|---|---|
| S01-pg-books-ingest | r047 | baseline: books table matches source files | postgres |
| S02-relata-typed-rows | r049 | 3 known fixture rows arrive in Relata as typed rows with the right fields | relata (http :9090) |
| S03-clickhouse-diamonds | r044 | whether 54,000 diamonds CSV rows arrive as columns or as text blobs | clickhouse |
| S04-es-wiki-parse | r140, r142 | Wikipedia HTML pages parse and chunk; Optical_fiber.html is the known failure | elasticsearch |
| S05-pg-retry-on-outage | r096 | what happens when Postgres goes down mid-run: retry, final status, lost or doubled rows | postgres + docker |
