import sample from './sample-run.json';
import blocked from './sample-run-blocked.json';
import passed from './sample-run-pass.json';
import { replay } from '../replay.js';

// Deterministic 2,000-row catalogue so the list virtualisation is exercised in
// mock mode. S01 is the real scenario with a recorded run; the rest replay the
// same recording under their own title.
const DBS = ['postgres', 'mongodb', 'clickhouse', 'elasticsearch', 'qdrant'];
const WHAT = ['books ingest', 'orders upsert', 'events stream', 'embeddings load', 'users export', 'logs rollup', 'invoices diff', 'cdr batch', 'catalog sync', 'metrics backfill'];
const EXTRA = ['baseline', 'regression', 'slow', 'idempotent', 'schema', 'cdc', 'retry', 'large'];
const VERDICTS = ['Pass', 'Pass', 'Pass', 'Fail', 'Blocked', null];

function makeScenarios() {
  const list = [{
    id: sample.events[0].scenario.id, title: sample.events[0].scenario.title,
    tracker_row: 'r047', tags: ['lab', 'postgres', 'baseline'], resources: ['postgres:lab'],
    stepCount: 10, lastRun: { runId: sample.run.runId, verdict: 'Fail', ts: sample.run.endedAt },
  }];
  for (let i = 2; i <= 2000; i++) {
    const db = DBS[i % DBS.length], what = WHAT[(i * 7) % WHAT.length];
    const v = VERDICTS[(i * 13) % VERDICTS.length];
    list.push({
      id: `S${String(i).padStart(4, '0')}-${db.slice(0, 3)}-${what.split(' ')[0]}`,
      title: `${db[0].toUpperCase() + db.slice(1)}: ${what} matches the source`,
      tracker_row: `r${String(40 + i).padStart(3, '0')}`,
      tags: ['lab', db, EXTRA[i % EXTRA.length], ...(i % 5 === 0 ? [EXTRA[(i + 3) % EXTRA.length]] : [])],
      resources: [`${db}:lab`], stepCount: 6 + (i % 5),
      lastRun: v ? { runId: `r_mock_${i}`, verdict: v, ts: `2026-10-${String(1 + (i % 26)).padStart(2, '0')}T09:${String(i % 60).padStart(2, '0')}:00.000Z` } : null,
    });
  }
  return list;
}

const scenarios = makeScenarios();
const stored = new Map();   // runId -> { run, events }
for (const s of [sample, blocked, passed]) stored.set(s.run.runId, s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let counter = 0;

function recording(runId, scenarioId) {
  const sc = scenarios.find((s) => s.id === scenarioId) || scenarios[0];
  const events = sample.events.map((e) => {
    const c = { ...e, runId };
    if (e.type === 'run.start') c.scenario = { ...e.scenario, id: sc.id, title: sc.title, tracker_row: sc.tracker_row, tags: sc.tags };
    return c;
  });
  return { run: { ...sample.run, runId, scenarioId: sc.id }, events };
}

export const mockApi = {
  mode: 'mock',
  async listScenarios() { await sleep(120); return scenarios; },
  async startRun(scenarioId) {
    await sleep(120);
    const runId = `r_mock_${Date.now().toString(36)}_${counter++}`;
    stored.set(runId, recording(runId, scenarioId));
    return runId;
  },
  async listRuns(scenarioId) {
    await sleep(100);
    // No scenario id: every stored run (the all-runs history page).
    if (!scenarioId) return [...stored.values()].map((r) => r.run).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const own = [...stored.values()].filter((r) => r.run.scenarioId === scenarioId).map((r) => r.run);
    // Old synthetic history for scenarios other than S01 so the screen is never empty.
    if (scenarioId !== sample.run.scenarioId && !own.length) {
      return ['Pass', 'Pass', 'Fail'].map((v, i) => ({ runId: `r_mock_old${i}`, scenarioId, verdict: v, startedAt: `2026-10-2${5 - i}T10:00:00.000Z`, endedAt: `2026-10-2${5 - i}T10:00:09.000Z` }));
    }
    return own.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },
  async getRun(runId) {
    await sleep(100);
    const r = stored.get(runId) || recording(runId, sample.run.scenarioId);
    return r;
  },
  // Live stream: replays the recording with its original timing.
  subscribe(runId, onEvent, onDone) {
    let cancel = () => {};
    let dead = false;
    const r = stored.get(runId) || recording(runId, sample.run.scenarioId);
    const t = setTimeout(() => { if (!dead) cancel = replay(r.events, onEvent, { onDone }); }, 200);
    return () => { dead = true; clearTimeout(t); cancel(); };
  },
};
