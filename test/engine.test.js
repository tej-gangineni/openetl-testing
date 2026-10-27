import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../src/engine.js';
import { resolve } from '../src/template.js';
import { createScheduler } from '../src/scheduler.js';
import { createStore } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterScenarios, validate } from '../src/scenarios.js';

const config = { lab: '/lab', repo: '/repo' };
const step = (id, action, args = {}, extra = {}) => ({ id, phase: 'observe', title: id, explain: `why ${id}`, action, args, ...extra });
const FLOW = { source: { kind: 'files', label: 'src' }, engine: { label: 'eng' }, target: { kind: 'postgres', label: 'tgt' } };
const scn = (steps, extra = {}) => ({ id: 'T', title: 'T', summary: 'sum', flow: FLOW, tags: [], resources: [], steps, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(scenario, actions, signal) {
  const events = [];
  const result = await runScenario(scenario, { actions, config, emit: (e) => events.push(e), signal });
  return { events, result, ends: events.filter((e) => e.type === 'step.end') };
}

test('all steps pass', async () => {
  const { events, result } = await run(scn([step('a', 'ok'), step('b', 'ok')]), { ok: async () => ({ ok: true, evidence: { x: 1 } }) });
  assert.equal(result.verdict, 'Pass');
  assert.deepEqual(result.counts, { pass: 2, fail: 0, blocked: 0, skipped: 0 });
  assert.deepEqual(events.map((e) => e.type), ['run.start', 'step.start', 'step.end', 'step.start', 'step.end', 'run.end']);
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(events[2].evidence, { x: 1 });
});

test('omitted ok counts as pass; logs are one event per line', async () => {
  const { events, result } = await run(scn([step('a', 'chatty')]), { chatty: async (_, ctx) => { ctx.log('one\ntwo'); return { value: 1 }; } });
  assert.equal(result.verdict, 'Pass');
  assert.deepEqual(events.filter((e) => e.type === 'step.log').map((e) => e.line), ['one', 'two']);
});

test('fail does not stop the run', async () => {
  const { ends, result } = await run(scn([step('a', 'bad'), step('b', 'ok')]), { bad: async () => ({ ok: false, evidence: { left: 1 } }), ok: async () => ({}) });
  assert.equal(result.verdict, 'Fail');
  assert.deepEqual(ends.map((e) => e.state), ['fail', 'pass']);
});

test('blocked skips the rest and wins over fail', async () => {
  const { events, ends, result } = await run(scn([step('a', 'bad'), step('b', 'boom'), step('c', 'ok'), step('d', 'ok')]), {
    bad: async () => ({ ok: false }), boom: async () => { throw new Error('db down'); }, ok: async () => ({}),
  });
  assert.equal(result.verdict, 'Blocked');
  assert.deepEqual(ends.map((e) => e.state), ['fail', 'blocked', 'skipped', 'skipped']);
  assert.equal(ends[1].error, 'db down');
  assert.deepEqual(result.counts, { pass: 0, fail: 1, blocked: 1, skipped: 2 });
  assert.equal(events.filter((e) => e.type === 'step.start').length, 2);
});

test('unknown action and unresolved variable block the step', async () => {
  const a = await run(scn([step('a', 'nope')]), {});
  assert.match(a.ends[0].error, /Unknown action/);
  const b = await run(scn([step('a', 'ok', { x: '${missing}' })]), { ok: async () => ({}) });
  assert.equal(b.result.verdict, 'Blocked');
});

test('template typing, nested paths and save', async () => {
  const seen = [];
  const actions = {
    produce: async () => ({ value: { n: 5, status: 'DONE' } }),
    count: async () => ({ value: 7 }),
    use: async (args) => { seen.push(args); return {}; },
  };
  await run(scn([
    step('p', 'produce', {}, { save: 'run' }),
    step('c', 'count', {}, { save: 'n' }),
    step('u', 'use', { num: '${n}', obj: '${run}', deep: '${run.n}', text: 'n=${n} s=${run.status}', path: '${lab}/x', list: ['${n}', 'k'], plain: 3 }),
  ]), actions);
  assert.deepEqual(seen[0], {
    num: 7, obj: { n: 5, status: 'DONE' }, deep: 5, text: 'n=7 s=DONE', path: '/lab/x', list: [7, 'k'], plain: 3,
  });
  assert.equal(resolve('${a}', { a: 0 }), 0);
  assert.equal(resolve('${a}', { a: null }), null);
});

test('scenario validation and filtering', () => {
  assert.throws(() => validate(scn([step('s', 'a', {}, { phase: 'bogus' })])), /phase/);
  const list = [validate(scn([step('a', 'x')], { id: 'S1', tags: ['pg'], title: 'Books' })), validate(scn([step('a', 'x')], { id: 'S2', tags: ['mongo'], title: 'Docs' }))];
  assert.deepEqual(filterScenarios(list, { tag: 'pg' }).map((s) => s.id), ['S1']);
  assert.deepEqual(filterScenarios(list, { q: 'docs' }).map((s) => s.id), ['S2']);
});

test('scenarios sharing a resource never overlap; others run in parallel', async () => {
  let live = 0;
  let liveDb = 0;
  let maxSameDb = 0;
  let sawParallel = false;
  const actions = {
    work: async (args) => {
      live++;
      if (args.db) { liveDb++; maxSameDb = Math.max(maxSameDb, liveDb); }
      if (!args.db && live > 1) sawParallel = true;
      await sleep(40);
      live--;
      if (args.db) liveDb--;
      return {};
    },
  };
  const store = createStore(':memory:');
  const scheduler = createScheduler({ store, actions, config, concurrency: 4 });
  const mk = (id, resources, db) => scn([step('w', 'work', { db })], { id, resources });
  const a = scheduler.enqueue(mk('A', ['db'], true));
  const b = scheduler.enqueue(mk('B', ['db'], true));
  scheduler.enqueue(mk('C', ['other'], false));
  await scheduler.idle();
  assert.equal(maxSameDb, 1);
  assert.ok(sawParallel, 'scenario on a different resource should overlap');
  assert.equal(store.getRun(a).verdict, 'Pass');
  assert.equal(store.getRun(b).verdict, 'Pass');
  const ea = store.getEvents(a).at(-1).ts;
  const sb = store.getEvents(b).find((e) => e.type === 'step.start').ts;
  assert.ok(sb >= ea, 'B starts after A ends');
});

test('concurrency 1 runs in FIFO order', async () => {
  const order = [];
  const store = createStore(':memory:');
  const scheduler = createScheduler({ store, config, concurrency: 1, actions: { mark: async (a) => { order.push(a.id); await sleep(5); return {}; } } });
  for (const id of ['1', '2', '3']) scheduler.enqueue(scn([step('m', 'mark', { id })], { id }));
  await scheduler.idle();
  assert.deepEqual(order, ['1', '2', '3']);
});

test('timeout aborts the run as Blocked, even if the action ignores the signal', async () => {
  const store = createStore(':memory:');
  const scheduler = createScheduler({ store, config, timeoutMs: 50, actions: { hang: () => new Promise(() => {}), ok: async () => ({}) } });
  const id = scheduler.enqueue(scn([step('h', 'hang'), step('after', 'ok')]));
  await scheduler.idle();
  const events = store.getEvents(id);
  const ends = events.filter((e) => e.type === 'step.end');
  assert.equal(store.getRun(id).verdict, 'Blocked');
  assert.deepEqual(ends.map((e) => e.state), ['blocked', 'skipped']);
  assert.match(ends[0].error, /timed out/);
});

test('abort signal reaches the action', async () => {
  const ctl = new AbortController();
  let sawAbort = false;
  const p = run(scn([step('w', 'wait')]), { wait: (_, ctx) => new Promise((r) => ctx.signal.addEventListener('abort', () => { sawAbort = true; r({}); })) }, ctl.signal);
  setTimeout(() => ctl.abort(new Error('stop')), 20);
  const { result, ends } = await p;
  assert.ok(sawAbort);
  assert.equal(result.verdict, 'Blocked');
  assert.equal(ends[0].error, 'stop');
});

test('step.log is capped to head + omitted marker + tail', async () => {
  const total = 142000;
  const { events } = await run(scn([step('a', 'flood')]), {
    flood: async (_, ctx) => { for (let i = 1; i <= total; i++) ctx.log(`line ${i}`); return {}; },
  });
  const logs = events.filter((e) => e.type === 'step.log').map((e) => e.line);
  assert.equal(logs.length, 401);
  assert.equal(logs[0], 'line 1');
  assert.equal(logs[199], 'line 200');
  assert.equal(logs[200], '... 141,600 lines omitted ...');
  assert.equal(logs[201], `line ${total - 199}`);
  assert.equal(logs.at(-1), `line ${total}`);
  assert.equal(events.at(-2).type, 'step.end');
  const lastLog = events.map((e) => e.type).lastIndexOf('step.log');
  assert.ok(lastLog < events.length - 2, 'tail is flushed before step.end');
});

test('step.log under the cap is untouched', async () => {
  const { events } = await run(scn([step('a', 'few')]), { few: async (_, ctx) => { for (let i = 0; i < 350; i++) ctx.log(`l${i}`); return {}; } });
  const logs = events.filter((e) => e.type === 'step.log').map((e) => e.line);
  assert.equal(logs.length, 350);
  assert.ok(!logs.some((l) => l.includes('omitted')));
});

test('closeInterrupted ends cut-off runs only', async () => {
  const store = createStore(':memory:');
  const events = [];
  store.createRun('r_done', 'T');
  await runScenario(scn([step('a', 'ok'), step('b', 'ok'), step('c', 'ok')]), {
    actions: { ok: async () => ({}) }, config, runId: 'r_done', emit: (e) => { events.push(e); store.addEvent(e); },
  });
  // Re-create a half-finished run: first 4 events (run.start, a start/end, b start).
  store.createRun('r_cut', 'T', undefined, 2147483646);
  events.slice(0, 4).forEach((e) => store.addEvent({ ...e, runId: 'r_cut' }));
  store.createRun('r_queued', 'T', undefined, 2147483646);
  store.createRun('r_live', 'T'); // owned by this live process: never swept
  assert.equal(store.closeInterrupted(), 2);
  assert.equal(store.getRun('r_live').verdict, null);
  const cut = store.getEvents('r_cut').at(-1);
  assert.equal(cut.type, 'run.end');
  assert.equal(cut.verdict, 'Blocked');
  assert.equal(cut.note, 'interrupted');
  assert.equal(cut.seq, 4);
  assert.deepEqual(cut.counts, { pass: 1, fail: 0, blocked: 0, skipped: 0 });
  assert.equal(store.getRun('r_cut').verdict, 'Blocked');
  assert.ok(store.getRun('r_cut').endedAt);
  assert.equal(store.getEvents('r_queued')[0].seq, 0);
  assert.equal(store.getRun('r_done').verdict, 'Pass');
  assert.equal(store.closeInterrupted(), 0);
  assert.equal(store.closeInterrupted('r_live'), 1, 'explicit close of an owned run');
});

test('validation requires summary, flow and per-step explain', () => {
  const ok = scn([step('a', 'x')]);
  assert.doesNotThrow(() => validate(ok));
  assert.throws(() => validate({ ...ok, summary: undefined }), /summary/);
  assert.throws(() => validate({ ...ok, flow: undefined }), /flow/);
  assert.throws(() => validate({ ...ok, flow: { ...FLOW, target: { kind: 'oracle', label: 'x' } } }), /kind/);
  assert.throws(() => validate({ ...ok, flow: { ...FLOW, engine: {} } }), /engine/);
  assert.throws(() => validate(scn([{ ...step('a', 'x'), explain: undefined }])), /explain/);
});

test('run.start and step.start carry summary, flow, explain, always', async () => {
  const { events } = await run(scn([step('a', 'ok'), step('b', 'ok', {}, { always: true })]), { ok: async () => ({}) });
  const sc = events[0].scenario;
  assert.equal(sc.summary, 'sum');
  assert.deepEqual(sc.flow, FLOW);
  assert.deepEqual(sc.steps.map((x) => [x.explain, x.always]), [['why a', false], ['why b', true]]);
  assert.equal(events.find((e) => e.type === 'step.start').explain, 'why a');
});

test('step.io is emitted before step.end; large io is truncated to 8 KB', async () => {
  const small = { kind: 'sql', request: { target: 't', text: 'SELECT 1' }, response: { columns: ['c'], rows: [[1]], rowCount: 1, truncated: false } };
  const rows = Array.from({ length: 20 }, (_, i) => [i, 'x'.repeat(200)]);
  const big = { kind: 'sql', request: { text: 'q' }, response: { columns: ['i', 's'], rows: Array.from({ length: 20 }, (_, i) => [i, 'y'.repeat(200)]).concat(rows).concat(rows), rowCount: 60, truncated: false } };
  const { events } = await run(scn([step('a', 'small'), step('b', 'big'), step('c', 'none')]), {
    small: async () => ({ io: small }), big: async () => ({ io: big }), none: async () => ({}),
  });
  const types = events.map((e) => e.type + ':' + (e.stepId ?? ''));
  assert.ok(types.indexOf('step.io:a') < types.indexOf('step.end:a'));
  assert.ok(!types.includes('step.io:c'));
  assert.deepEqual(events.find((e) => e.type === 'step.io' && e.stepId === 'a').io, small);
  const bigIo = events.find((e) => e.type === 'step.io' && e.stepId === 'b').io;
  assert.ok(JSON.stringify(bigIo).length <= 8192);
  assert.equal(bigIo.response.truncated, true);
  assert.ok(bigIo.response.rows.length < 60);
  assert.equal(bigIo.response.rowCount, 60);
});

test('detail log lines never displace info lines', async () => {
  const { events } = await run(scn([step('a', 'mix')]), {
    mix: async (_, ctx) => {
      for (let i = 1; i <= 300; i++) ctx.log(`info ${i}`);
      for (let i = 1; i <= 5000; i++) ctx.log(`[SUBSTEP] d${i}`);
      ctx.log('info last');
      return {};
    },
  });
  const logs = events.filter((e) => e.type === 'step.log');
  const info = logs.filter((e) => e.level === 'info').map((e) => e.line);
  const detail = logs.filter((e) => e.level === 'detail').map((e) => e.line);
  assert.equal(info.length, 301);
  assert.equal(info[0], 'info 1');
  assert.equal(info.at(-1), 'info last');
  assert.ok(!info.some((l) => l.includes('omitted')));
  assert.equal(detail.length, 201);
  assert.equal(detail[100], '... 4,800 lines omitted ...');
  assert.equal(detail.at(-1), '[SUBSTEP] d5000');
  assert.ok(logs.every((e) => e.level === 'info' || e.level === 'detail'));
});

test('always steps run after a blocked step and count in the verdict', async () => {
  const { ends, result } = await run(scn([
    step('a', 'boom'), step('b', 'ok'), step('c', 'ok', {}, { always: true }), step('d', 'bad', {}, { always: true }),
  ]), { boom: async () => { throw new Error('x'); }, ok: async () => ({}), bad: async () => ({ ok: false }) });
  assert.deepEqual(ends.map((e) => e.state), ['blocked', 'skipped', 'pass', 'fail']);
  assert.deepEqual(result.counts, { pass: 1, fail: 1, blocked: 1, skipped: 1 });
  const r2 = await run(scn([step('a', 'boom'), step('c', 'boom', {}, { always: true })]), { boom: async () => { throw new Error('x'); } });
  assert.deepEqual(r2.result.counts, { pass: 0, fail: 0, blocked: 2, skipped: 0 });
});

test('opening a pre-v2 database adds runs.pid and keeps its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-'));
  const file = path.join(dir, 'results.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE runs (run_id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, verdict TEXT, started_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, step_id TEXT, json TEXT NOT NULL, PRIMARY KEY (run_id, seq));
    INSERT INTO runs (run_id, scenario_id, verdict, started_at) VALUES ('old1', 'S', 'Pass', '2026-01-01T00:00:00Z');
    INSERT INTO runs (run_id, scenario_id, started_at) VALUES ('old2', 'S', '2026-01-01T00:00:00Z');`);
  old.close();
  const store = createStore(file);
  assert.equal(store.getRun('old1').verdict, 'Pass');
  assert.equal(store.closeInterrupted(), 1); // old2 has no pid: treated as gone
  assert.equal(store.getRun('old2').verdict, 'Blocked');
  store.close();
  assert.doesNotThrow(() => createStore(file).close()); // second open: column already there
  fs.rmSync(dir, { recursive: true });
});

test('flow placeholders resolve in run.start; unknown ones stay as written', async () => {
  const flow = { ...FLOW, source: { kind: 'files', label: 'src', detail: '${lab}/downloads and ${repo} ${nope}' } };
  const { events } = await run(scn([step('a', 'ok')], { flow }), { ok: async () => ({}) });
  assert.equal(events[0].scenario.flow.source.detail, '/lab/downloads and /repo ${nope}');
  assert.equal(flow.source.detail.startsWith('${lab}'), true, 'scenario object is not mutated');
});
