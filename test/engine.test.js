import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../src/engine.js';
import { resolve } from '../src/template.js';
import { createScheduler } from '../src/scheduler.js';
import { createStore } from '../src/store.js';
import { filterScenarios, validate } from '../src/scenarios.js';

const config = { lab: '/lab', repo: '/repo' };
const step = (id, action, args = {}, extra = {}) => ({ id, phase: 'observe', title: id, action, args, ...extra });
const scn = (steps, extra = {}) => ({ id: 'T', title: 'T', tags: [], resources: [], steps, ...extra });
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
  assert.throws(() => validate({ id: 'x', title: 't', steps: [{ id: 's', phase: 'bogus', title: 't', action: 'a' }] }), /phase/);
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
  store.createRun('r_cut', 'T');
  events.slice(0, 4).forEach((e) => store.addEvent({ ...e, runId: 'r_cut' }));
  store.createRun('r_queued', 'T');
  assert.equal(store.closeInterrupted(), 2);
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
});
