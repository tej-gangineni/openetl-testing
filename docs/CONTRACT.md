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
