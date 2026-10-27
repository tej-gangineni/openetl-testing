// Feeds the recorded sample runs through the reducer and checks final node states.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runReducer, initialRun, phaseState } from '../src/reducer.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../src/mock/${n}`, import.meta.url)));
const fold = (evs) => evs.reduce(runReducer, initialRun);

// Fail run
let { events } = load('sample-run.json');
let s = fold(events);
assert.deepEqual(s.order, ['empty', 'src', 'run', 'status', 'rows', 'count', 'dupes', 'sample']);
assert.deepEqual(Object.fromEntries(s.order.map((id) => [id, s.steps[id].state])),
  { empty: 'pass', src: 'pass', run: 'pass', status: 'pass', rows: 'pass', count: 'fail', dupes: 'pass', sample: 'pass' });
assert.deepEqual(s.steps.count.evidence, { left: 1994, op: 'eq', right: 1997 });
assert.equal(s.steps.run.logs.length, 10);
assert.equal(s.verdict, 'Fail');
assert.deepEqual(s.counts, { pass: 7, fail: 1, blocked: 0, skipped: 0 });
assert.equal(phaseState(s, 'verify'), 'fail');
assert.equal(phaseState(s, 'prepare'), 'pass');

// Mid-run: stop at step.start of "run" -> running; later steps still waiting
const mid = fold(events.slice(0, events.findIndex((e) => e.type === 'step.start' && e.stepId === 'run') + 1));
assert.equal(mid.steps.run.state, 'running');
assert.equal(mid.steps.status.state, 'waiting');
assert.equal(mid.verdict, null);

// Duplicate delivery (SSE reconnect) must not double logs
const dup = fold([...events.slice(0, 12), ...events.slice(0, 12)]);
assert.deepEqual(dup, fold(events.slice(0, 12)));

// Blocked run: blocked step, later steps skipped
({ events } = load('sample-run-blocked.json'));
s = fold(events);
assert.deepEqual(s.order.map((id) => s.steps[id].state), ['pass', 'pass', 'pass', 'pass', 'blocked', 'skipped', 'skipped', 'skipped']);
assert.equal(s.verdict, 'Blocked');
assert.deepEqual(s.counts, { pass: 4, fail: 0, blocked: 1, skipped: 3 });
assert.match(s.steps.rows.error, /not running/);
assert.equal(phaseState(s, 'observe'), 'blocked');
assert.equal(phaseState(s, 'verify'), 'skipped');

console.log('reducer tests passed');
