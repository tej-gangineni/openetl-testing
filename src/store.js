import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { root } from './config.js';

export const defaultDbPath = path.join(root, 'data', 'results.db');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function createStore(file = defaultDbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, verdict TEXT,
      started_at TEXT NOT NULL, ended_at TEXT, pid INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL,
      type TEXT NOT NULL, step_id TEXT, json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS runs_scenario ON runs (scenario_id, started_at);
  `);

  // Databases made before v2 lack runs.pid: add it, touching no rows.
  if (!db.prepare('PRAGMA table_info(runs)').all().some((c) => c.name === 'pid')) {
    db.exec('ALTER TABLE runs ADD COLUMN pid INTEGER');
  }

  const q = {
    insRun: db.prepare('INSERT INTO runs (run_id, scenario_id, started_at, pid) VALUES (?, ?, ?, ?)'),
    insEvent: db.prepare('INSERT INTO events (run_id, seq, ts, type, step_id, json) VALUES (?, ?, ?, ?, ?, ?)'),
    endRun: db.prepare('UPDATE runs SET verdict = ?, ended_at = ? WHERE run_id = ?'),
    run: db.prepare('SELECT * FROM runs WHERE run_id = ?'),
    open: db.prepare('SELECT * FROM runs WHERE verdict IS NULL'),
    events: db.prepare('SELECT json FROM events WHERE run_id = ? ORDER BY seq'),
    last: db.prepare('SELECT run_id, verdict, started_at, ended_at FROM runs WHERE scenario_id = ? AND verdict IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1'),
    all: db.prepare('SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?'),
    byScenario: db.prepare('SELECT * FROM runs WHERE scenario_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?'),
  };

  const toRun = (r) => r && {
    runId: r.run_id, scenarioId: r.scenario_id, verdict: r.verdict ?? null,
    startedAt: r.started_at, endedAt: r.ended_at ?? null,
  };

  return {
    createRun(runId, scenarioId, startedAt = new Date().toISOString(), pid = process.pid) {
      q.insRun.run(runId, scenarioId, startedAt, pid);
    },
    addEvent(ev) {
      q.insEvent.run(ev.runId, ev.seq, ev.ts, ev.type, ev.stepId ?? null, JSON.stringify(ev));
      if (ev.type === 'run.end') q.endRun.run(ev.verdict, ev.ts, ev.runId);
    },
    getRun: (runId) => toRun(q.run.get(runId)),
    getEvents: (runId) => q.events.all(runId).map((r) => JSON.parse(r.json)),
    listRuns({ scenarioId, limit = 50 } = {}) {
      const n = Math.max(1, Math.min(500, Number(limit) || 50));
      return (scenarioId ? q.byScenario.all(scenarioId, n) : q.all.all(n)).map(toRun);
    },
    lastRun(scenarioId) {
      const r = q.last.get(scenarioId);
      return r ? { runId: r.run_id, verdict: r.verdict, ts: r.ended_at ?? r.started_at } : null;
    },
    // Ends runs that were cut off so they do not look like they are still running.
    // With a runId: that one run (the caller owns it). Without: the startup sweep, which only
    // touches runs whose owning process is gone (a missing pid, from before v2, counts as gone).
    closeInterrupted(runId) {
      const open = runId
        ? [q.run.get(runId)].filter((r) => r && r.verdict === null)
        : q.open.all().filter((r) => !pidAlive(r.pid));
      for (const r of open) {
        const events = q.events.all(r.run_id).map((e) => JSON.parse(e.json));
        const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
        for (const e of events) if (e.type === 'step.end') counts[e.state]++;
        const ts = new Date().toISOString();
        this.addEvent({
          runId: r.run_id, seq: events.length ? events[events.length - 1].seq + 1 : 0, ts, type: 'run.end',
          verdict: 'Blocked', counts, ms: Date.parse(ts) - Date.parse(r.started_at), note: 'interrupted',
        });
      }
      return open.length;
    },
    close: () => db.close(),
  };
}
