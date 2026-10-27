// Feeds the recorded v2 sample runs through the reducer and checks final state,
// io capture, counters, before/after pairing and the diff sentence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runReducer, initialRun, phaseState, counters, touching, comparePairs, effectiveIo, describeDiff, resolveDetail, PHASE_NAME } from '../src/reducer.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../src/mock/${n}`, import.meta.url)));
const fold = (evs) => evs.reduce(runReducer, initialRun);
const states = (s) => Object.fromEntries(s.order.map((id) => [id, s.steps[id].state]));

// Fail run
let { events } = load('sample-run.json');
let s = fold(events);
assert.deepEqual(s.order, ['before', 'empty', 'src', 'run', 'status', 'rows', 'count', 'dupes', 'sample', 'after']);
assert.deepEqual(states(s), { before: 'pass', empty: 'pass', src: 'pass', run: 'pass', status: 'pass', rows: 'pass', count: 'fail', dupes: 'pass', sample: 'pass', after: 'pass' });
assert.deepEqual(s.steps.count.evidence, { left: 1994, op: 'eq', right: 1997 });
assert.equal(s.steps.count.io.kind, 'compare');
assert.equal(s.steps.run.logs.filter((l) => l.level !== 'detail').length, 11);
assert.equal(s.steps.run.logs.filter((l) => l.level === 'detail').length, 120);
assert.equal(s.steps.run.io.response.summary.records_written, 1994);
assert.deepEqual(s.steps.sample.io.response.columns, ['id', 'text', 'source_filename']);
assert.equal(s.scenario.summary.startsWith('Splits 8'), true);
assert.equal(s.scenario.flow.target.kind, 'postgres');
assert.equal(s.scenario.flow.source.label, '8 Gutenberg book .txt files');
assert.equal(s.steps.src.io.response.count, 8);
assert.ok(!JSON.stringify(s).includes('author'));
assert.equal(s.steps.run.explain, 'Runs the real pipeline. Everything below checks what it produced.');
assert.equal(s.verdict, 'Fail');
assert.deepEqual(s.counts, { pass: 9, fail: 1, blocked: 0, skipped: 0 });
assert.equal(phaseState(s, 'verify'), 'fail');
assert.equal(phaseState(s, 'prepare'), 'pass');
assert.equal(PHASE_NAME.verify, 'Check the database');

// counters come only from events: files 1997, records 1994, rows 1994 (latest count)
assert.deepEqual(counters(s), { files: 8, records: 1994, rows: 1994 });

// before/after pairing by compareKey
const pairs = comparePairs(s);
assert.equal(pairs.after.get('after'), 'before');
assert.ok(pairs.before.has('before'));
assert.equal(describeDiff(['a', 'b'], 'eq', []), 'Expected an empty list; got 2 items.');
assert.equal(describeDiff([], 'eq', ['a']), 'Expected 1 item; got an empty list.');
assert.equal(resolveDetail('${lab}/downloads/books'), '/downloads/books');
assert.equal(resolveDetail('host:5433/db'), 'host:5433/db');
assert.equal(describeDiff(1994, 'eq', 1997), '1994 is 3 less than the expected 1997.');
assert.match(describeDiff('a', 'eq', 'b'), /not the same/);

// Mid-run: stop at step.start of "run" -> running, engine is touched; later steps waiting
const mid = fold(events.slice(0, events.findIndex((e) => e.type === 'step.start' && e.stepId === 'run') + 1));
assert.equal(mid.steps.run.state, 'running');
assert.equal(mid.steps.status.state, 'waiting');
assert.equal(mid.verdict, null);
assert.equal(touching(mid), 'engine');
assert.deepEqual(counters(mid), { files: 8, records: null, rows: 212 });
// While the first sql snapshot runs, the target is the box in use
const early = fold(events.slice(0, events.findIndex((e) => e.type === 'step.start' && e.stepId === 'before') + 1));
assert.equal(touching(early), 'target');

// Duplicate delivery (SSE reconnect) must not double logs or io
const dup = fold([...events.slice(0, 30), ...events.slice(0, 30)]);
assert.deepEqual(dup, fold(events.slice(0, 30)));

// Blocked run: blocked step, later steps skipped, after (before/after pair) never reached
({ events } = load('sample-run-blocked.json'));
s = fold(events);
assert.deepEqual(s.order.map((id) => s.steps[id].state), ['pass', 'pass', 'pass', 'pass', 'pass', 'blocked', 'skipped', 'skipped', 'skipped', 'skipped']);
assert.equal(s.verdict, 'Blocked');
assert.deepEqual(s.counts, { pass: 5, fail: 0, blocked: 1, skipped: 4 });
assert.match(s.steps.rows.error, /not running/);
assert.equal(s.steps.after.io, null);
assert.equal(phaseState(s, 'observe'), 'blocked');
assert.equal(phaseState(s, 'verify'), 'skipped');

// Pass run
({ events } = load('sample-run-pass.json'));
s = fold(events);
assert.equal(s.verdict, 'Pass');
assert.deepEqual(s.counts, { pass: 10, fail: 0, blocked: 0, skipped: 0 });
assert.deepEqual(counters(s), { files: 8, records: 1997, rows: 1997 });

// Older runs without step.io still display: evidence becomes io
const legacy = effectiveIo({ io: null, evidence: { sql: 'SELECT 1', rows: [{ a: 1, b: 'x' }] } });
assert.deepEqual(legacy.response.columns, ['a', 'b']);
assert.equal(effectiveIo({ io: null, evidence: { left: 1, op: 'eq', right: 2 } }).kind, 'compare');
assert.equal(effectiveIo({ io: null, evidence: undefined }), null);

console.log('reducer tests passed');
