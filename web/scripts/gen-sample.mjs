// Regenerates src/mock/sample-run.json (Fail verdict) and sample-run-blocked.json
// (Blocked verdict, shows blocked + skipped). Event shapes follow docs/CONTRACT.md.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = (n) => fileURLToPath(new URL(`../src/mock/${n}`, import.meta.url));
const SQL_COUNT = 'SELECT count(*) FROM books';
const steps = [
  { id: 'empty', phase: 'prepare', title: 'Empty the books table' },
  { id: 'src', phase: 'prepare', title: 'Count source files' },
  { id: 'run', phase: 'trigger', title: 'Run the pipeline' },
  { id: 'status', phase: 'observe', title: 'Run finished clean' },
  { id: 'rows', phase: 'observe', title: 'Count rows loaded' },
  { id: 'count', phase: 'verify', title: 'Row count equals source file count' },
  { id: 'dupes', phase: 'verify', title: 'No duplicate book ids' },
  { id: 'sample', phase: 'verify', title: 'Sample row has title and author' },
];
const scenario = {
  id: 'S01-pg-books-ingest', title: 'Postgres: books load matches the source',
  tracker_row: 'r047', tags: ['lab', 'postgres', 'baseline'], steps,
};

function build(runId, blockAt) {
  const events = [];
  let t = Date.parse('2026-10-27T12:00:00.000Z');
  let seq = 0;
  const emit = (dt, e) => { t += dt; events.push({ runId, seq: seq++, ts: new Date(t).toISOString(), ...e }); };
  const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  const start = t;
  emit(0, { type: 'run.start', scenario });
  const script = {
    empty: { logs: ['DROP TABLE IF EXISTS books', 'table books dropped'], ms: 310, evidence: { table: 'books', dropped: true } },
    src: { logs: ['scanning lab/downloads/books/*.txt', '1997 files matched'], ms: 48, evidence: { dir: 'lab/downloads/books', glob: '*.txt', count: 1997 } },
    run: {
      logs: ['openetl job run pg_books.toml', 'load plugin: postgres', 'source: file glob, 1997 inputs', 'batch 1/4 ... 500 rows', 'batch 2/4 ... 500 rows', 'batch 3/4 ... 500 rows', 'batch 4/4 ... 494 rows', 'sink flushed, 1994 rows written', '3 inputs rejected: empty body', 'status COMPLETED'],
      ms: 6400, evidence: { status: 'COMPLETED', rows_written: 1994, rejected: 3 },
    },
    status: { logs: ['compare COMPLETED eq COMPLETED'], ms: 4, evidence: { left: 'COMPLETED', op: 'eq', right: 'COMPLETED' } },
    rows: { logs: [`sql: ${SQL_COUNT}`, 'scalar: 1994'], ms: 120, evidence: { sql: SQL_COUNT, rows: [[1994]] } },
    count: { logs: ['compare 1994 eq 1997'], ms: 3, state: 'fail', evidence: { left: 1994, op: 'eq', right: 1997 } },
    dupes: { logs: ['sql: SELECT count(*) - count(DISTINCT book_id) FROM books', 'scalar: 0'], ms: 95, evidence: { sql: 'SELECT count(*) - count(DISTINCT book_id) FROM books', rows: [[0]] } },
    sample: {
      logs: ['sql: SELECT book_id, title, author FROM books ORDER BY random() LIMIT 3', '3 rows'], ms: 88,
      evidence: { sql: 'SELECT book_id, title, author FROM books ORDER BY random() LIMIT 3', rows: [{ book_id: 1342, title: 'Pride and Prejudice', author: 'Austen, Jane' }, { book_id: 84, title: 'Frankenstein', author: 'Shelley, Mary Wollstonecraft' }, { book_id: 2701, title: 'Moby Dick', author: 'Melville, Herman' }] },
    },
  };
  let blocked = false;
  for (const s of steps) {
    if (blocked) { emit(5, { type: 'step.end', stepId: s.id, phase: s.phase, state: 'skipped' }); counts.skipped++; continue; }
    emit(40, { type: 'step.start', stepId: s.id, phase: s.phase, title: s.title });
    const d = script[s.id];
    if (s.id === blockAt) {
      emit(300, { type: 'step.log', stepId: s.id, line: `sql: ${SQL_COUNT}` });
      emit(900, { type: 'step.log', stepId: s.id, line: 'docker exec openetl-lab-postgres psql ...' });
      emit(200, { type: 'step.end', stepId: s.id, phase: s.phase, state: 'blocked', error: 'Cannot reach container openetl-lab-postgres: it is not running.', ms: 1400 });
      counts.blocked++; blocked = true; continue;
    }
    const gap = Math.max(60, Math.round(d.ms / (d.logs.length + 1)));
    for (const line of d.logs) emit(gap, { type: 'step.log', stepId: s.id, line });
    const state = d.state || 'pass';
    counts[state]++;
    emit(gap, { type: 'step.end', stepId: s.id, phase: s.phase, state, evidence: d.evidence, ms: d.ms });
  }
  const verdict = counts.blocked ? 'Blocked' : counts.fail ? 'Fail' : 'Pass';
  emit(20, { type: 'run.end', verdict, counts, ms: t - start });
  return { run: { runId, scenarioId: scenario.id, verdict, startedAt: events[0].ts, endedAt: events.at(-1).ts }, events };
}

writeFileSync(out('sample-run.json'), JSON.stringify(build('r_20261027_ab12', null), null, 2) + '\n');
writeFileSync(out('sample-run-blocked.json'), JSON.stringify(build('r_20261026_c9d4', 'rows'), null, 2) + '\n');
