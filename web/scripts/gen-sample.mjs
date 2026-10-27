// Regenerates src/mock/sample-run*.json with Contract v2 events (io, explain,
// levelled logs, before/after pairs). Run: node scripts/gen-sample.mjs
//   sample-run.json         Fail    (1994 rows loaded, 1997 expected)
//   sample-run-blocked.json Blocked (Postgres went away; later steps skipped)
//   sample-run-pass.json    Pass
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = (n) => fileURLToPath(new URL(`../src/mock/${n}`, import.meta.url));
const TARGET = 'openetl-lab-postgres';
const sql = (text, columns, rows, extra = {}) => ({
  kind: 'sql', request: { target: TARGET, text },
  response: { columns, rows, rowCount: rows.length, truncated: false, ...extra },
});

const flow = {
  source: { kind: 'files', label: '8 Gutenberg book .txt files', detail: '${lab}/downloads/books' },
  engine: { label: 'openetl job run pg_books' },
  target: { kind: 'postgres', label: 'Postgres table books', detail: 'openetl-lab-postgres:5433/openetl' },
};
const steps = [
  { id: 'before', phase: 'prepare', compareKey: 'books-summary', title: 'Look at the books table before the run',
    explain: 'Records what is in the table now, so we can see exactly what the run changed.' },
  { id: 'empty', phase: 'prepare', title: 'Empty the books table',
    explain: 'Drops the table so every row we find afterwards was written by this run.' },
  { id: 'src', phase: 'prepare', title: 'Count the source files',
    explain: 'Counts the .txt files OpenETL is given. Eight files are split into chunks, so rows will not equal files.' },
  { id: 'run', phase: 'trigger', title: 'Run the pipeline',
    explain: 'Runs the real pipeline. Everything below checks what it produced.' },
  { id: 'status', phase: 'observe', title: 'The run finished clean',
    explain: 'OpenETL should end with status COMPLETED, not FAILED or PARTIAL.' },
  { id: 'rows', phase: 'observe', title: 'Count the rows OpenETL loaded',
    explain: 'Asks Postgres directly how many rows are in the table now.' },
  { id: 'count', phase: 'verify', title: 'Row count equals the known chunk count',
    explain: 'The 8 books are known to split into 1,997 chunks, and each chunk should become exactly one row.' },
  { id: 'dupes', phase: 'verify', title: 'No chunk was loaded twice',
    explain: 'A retry or restart can write the same chunk twice; this counts repeated ids.' },
  { id: 'sample', phase: 'verify', title: 'A sample row has text and a source file',
    explain: 'Reads three random rows to prove the columns hold real text and a file name, not blanks.' },
  { id: 'after', phase: 'verify', compareKey: 'books-summary', title: 'Look at the books table after the run',
    explain: 'Same query as the first step, so the change is visible side by side.' },
];
const scenario = {
  id: 'S01-pg-books-ingest', title: 'Postgres: books load matches the source',
  tracker_row: 'r047', tags: ['lab', 'postgres', 'baseline'],
  summary: 'Splits 8 Gutenberg books into 1,997 chunks, loads them into Postgres and proves the table matches.',
  flow,
  steps: steps.map(({ id, phase, title, explain, compareKey }) => ({ id, phase, title, explain, always: false, ...(compareKey ? { compareKey } : {}) })),
};

const SUMMARY_Q = 'SELECT count(*) AS chunks, count(DISTINCT source_filename) AS files, max(id) AS newest_id FROM books';
const COUNT_Q = 'SELECT count(*) FROM books';
const SAMPLE_Q = 'SELECT id, text, source_filename FROM books ORDER BY random() LIMIT 3';
const DUPE_Q = 'SELECT count(*) - count(DISTINCT id) AS repeats FROM books';

function runLogs(written) {
  const info = ['openetl 0.9.4  job pg_books', 'source: file glob, 8 inputs', 'chunked 8 files into 1997 records', 'sink: postgres table books', `sink flushed, ${written} rows written`];
  if (written < 1997) info.push(`${1997 - written} chunks rejected: empty text`);
  info.push('status COMPLETED');
  const lines = [{ line: info[0] }, { line: info[1] }, { line: info[2] }];
  for (let i = 1; i <= 120; i++) {
    const n = 1000 + i * 8;
    lines.push({ line: `[SUBSTEP] embed chunk ${i * 16} of pg${[1342, 84, 2701, 11, 1661, 98, 1952, 174][i % 8]}.txt  ${(900 + (i * 37) % 700)} chars`, level: 'detail' });
    if (i % 30 === 0) lines.push({ line: `batch ${i / 30}/4 ... ${i === 120 ? written - 1500 : 500} rows` });
  }
  for (const l of info.slice(3)) lines.push({ line: l });
  return lines;
}

function build(runId, { startAt, blockAt, loaded }) {
  const events = [];
  let t = Date.parse(startAt);
  let seq = 0;
  const emit = (dt, e) => { t += dt; events.push({ runId, seq: seq++, ts: new Date(t).toISOString(), ...e }); };
  const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  const start = t;
  const sampleRows = [[1342, 'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.', 'pg1342.txt'], [731, 'You will rejoice to hear that no disaster has accompanied the commencement of an enterprise which you have regarded with such evil forebodings.', 'pg84.txt'], [1790, 'Call me Ishmael. Some years ago, never mind how long precisely, having little or no money in my purse.', 'pg2701.txt']];
  const script = {
    before: { ms: 90, logs: [{ line: 'connected to openetl-lab-postgres' }], io: sql(SUMMARY_Q, ['chunks', 'files', 'newest_id'], [[212, 2, 2412]]) },
    empty: { ms: 310, logs: [{ line: 'DROP TABLE IF EXISTS books' }, { line: 'table books dropped' }], io: sql('DROP TABLE IF EXISTS books', ['result'], [['DROP TABLE']]) },
    src: { ms: 48, logs: [{ line: 'scanning downloads/books/*.txt' }, { line: '8 files matched' }],
      io: { kind: 'fs', request: { path: 'openetl-data-lab/downloads/books', glob: '*.txt' }, response: { count: 8, columns: ['file', 'bytes'], rows: [['pg1342.txt', 735000], ['pg84.txt', 448000], ['pg2701.txt', 1240000], ['pg11.txt', 174000], ['pg1661.txt', 593000], ['pg98.txt', 777000], ['pg1952.txt', 52000], ['pg174.txt', 441000]], rowCount: 8, truncated: false } } },
    run: { ms: 6400, logs: runLogs(loaded),
      io: { kind: 'command', request: { text: 'uv run openetl job run pipelines/pg_books.toml', cwd: 'openetl-data-lab' },
        response: { exitCode: 0, summary: { status: 'COMPLETED', files_found: 8, records_read: 1997, records_written: loaded, rejected: 1997 - loaded, duration_s: 6.4 } } } },
    status: { ms: 4, logs: [], io: { kind: 'compare', request: { left: 'COMPLETED', op: 'eq', right: 'COMPLETED' } } },
    rows: { ms: 120, logs: [{ line: 'connected to openetl-lab-postgres' }], io: sql(COUNT_Q, ['count'], [[loaded]]) },
    count: { ms: 3, logs: [], io: { kind: 'compare', request: { left: loaded, op: 'eq', right: 1997 } }, ok: loaded === 1997 },
    dupes: { ms: 95, logs: [], io: sql(DUPE_Q, ['repeats'], [[0]]) },
    sample: { ms: 88, logs: [], io: sql(SAMPLE_Q, ['id', 'text', 'source_filename'], sampleRows) },
    after: { ms: 92, logs: [], io: sql(SUMMARY_Q, ['chunks', 'files', 'newest_id'], [[loaded, 8, 2000]]) },
  };
  emit(0, { type: 'run.start', scenario });
  let blocked = false;
  for (const s of steps) {
    if (blocked) { emit(5, { type: 'step.end', stepId: s.id, phase: s.phase, state: 'skipped' }); counts.skipped++; continue; }
    emit(40, { type: 'step.start', stepId: s.id, phase: s.phase, title: s.title, explain: s.explain });
    const d = script[s.id];
    if (s.id === blockAt) {
      emit(300, { type: 'step.log', stepId: s.id, line: 'connecting to openetl-lab-postgres' });
      emit(900, { type: 'step.log', stepId: s.id, line: 'docker exec openetl-lab-postgres psql -U lab -d openetl' });
      emit(200, { type: 'step.end', stepId: s.id, phase: s.phase, state: 'blocked', error: 'Cannot reach container openetl-lab-postgres: it is not running. Start it with docker start openetl-lab-postgres and run again.', ms: 1400 });
      counts.blocked++; blocked = true; continue;
    }
    const gap = Math.max(40, Math.round(d.ms / (Math.min(d.logs.length, 14) + 1)));
    for (const l of d.logs) emit(l.level === 'detail' ? 15 : gap, { type: 'step.log', stepId: s.id, line: l.line, level: l.level || 'info' });
    emit(gap, { type: 'step.io', stepId: s.id, io: d.io });
    const state = d.ok === false ? 'fail' : 'pass';
    counts[state]++;
    emit(30, { type: 'step.end', stepId: s.id, phase: s.phase, state, ms: d.ms,
      ...(d.io.kind === 'compare' ? { evidence: d.io.request } : {}) });
  }
  const verdict = counts.blocked ? 'Blocked' : counts.fail ? 'Fail' : 'Pass';
  emit(20, { type: 'run.end', verdict, counts, ms: t - start, ...(blocked ? { note: 'stopped at the first blocked step' } : {}) });
  return { run: { runId, scenarioId: scenario.id, verdict, startedAt: events[0].ts, endedAt: events.at(-1).ts }, events };
}

const w = (n, o) => writeFileSync(out(n), JSON.stringify(o, null, 1) + '\n');
w('sample-run.json', build('r_20261027_ab12', { startAt: '2026-10-27T12:00:00.000Z', loaded: 1994 }));
w('sample-run-blocked.json', build('r_20261026_c9d4', { startAt: '2026-10-26T16:30:00.000Z', loaded: 1997, blockAt: 'rows' }));
w('sample-run-pass.json', build('r_20261025_77f0', { startAt: '2026-10-25T09:10:00.000Z', loaded: 1997 }));
