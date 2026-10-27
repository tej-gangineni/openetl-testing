import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import actions from '../src/actions/index.js';
import { parseSummary, clean } from '../src/actions/openetl.js';
import { checkSelect, checkTable, dropTable, scalar } from '../src/actions/pg.js';

const SAMPLE = `  [SUBSTEP] something
\x1b[32m╭──────────────────────── openetl job run — COMPLETED ─────────────────────────╮\x1b[0m
│ ✔ Job /x/pipelines/pg_books.toml                                             │
│ COMPLETED                                                                    │
│                                                                              │
│ run_id:   run_1793083980_4537b131                                            │
│ env:      dev                                                                │
│ files:    8                                                                  │
│ records:  1997                                                               │
│ warnings: 0                                                                  │
│ elapsed:  8.17s                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯`;

test('index exposes all required actions', () => {
  for (const k of ['pg.dropTable', 'pg.scalar', 'pg.rows', 'fs.countFiles', 'openetl.jobRun', 'check.compare']) {
    assert.equal(typeof actions[k], 'function', k);
  }
});

test('parseSummary reads the panel', () => {
  assert.deepEqual(parseSummary(SAMPLE), { status: 'COMPLETED', files: 8, records: 1997, warnings: 0, elapsedSeconds: 8.17 });
});

test('parseSummary: no panel gives UNKNOWN; FAILED and PARTIAL recognised', () => {
  assert.equal(parseSummary('boom').status, 'UNKNOWN');
  assert.equal(parseSummary('╭─ openetl job run — FAILED ─╮').status, 'FAILED');
  assert.equal(parseSummary('╭─ openetl job run — PARTIAL ─╮').status, 'PARTIAL');
});

test('clean strips ANSI and box characters', () => {
  assert.equal(clean('\x1b[1;32m│ files:    8   │\x1b[0m'), 'files:    8');
});

test('checkSelect accepts one SELECT and rejects the rest', () => {
  assert.equal(checkSelect(' select 1; '), 'select 1');
  for (const bad of ['DROP TABLE books', 'select 1; select 2', 'select 1; drop table x', 'delete from books',
    'select * into foo from books', 'select 1 -- x', 'select /* x */ 1', 'with a as (select 1) select * from a', '']) {
    assert.throws(() => checkSelect(bad), undefined, bad);
  }
});

test('checkTable enforces the regex', () => {
  assert.equal(checkTable('books_2'), 'books_2');
  for (const bad of ['Books', '1books', 'a-b', 'a;drop', 'a b', '', null]) assert.throws(() => checkTable(bad), undefined, String(bad));
});

test('pg actions refuse disallowed containers and bad input before touching Docker', async () => {
  const ctx = { config: { allowedContainers: ['x'], pg: { container: 'other', user: 'u', db: 'd' } } };
  await assert.rejects(dropTable({ table: 'books' }, ctx), /not allowed/);
  await assert.rejects(scalar({ sql: 'select 1' }, ctx), /not allowed/);
  await assert.rejects(dropTable({ table: 'x; drop' }, ctx), /Invalid table/);
  await assert.rejects(scalar({ sql: 'delete from t' }, ctx), /SELECT/);
});

test('check.compare ops', async () => {
  const c = (left, op, right) => actions['check.compare']({ left, op, right }, {});
  assert.equal((await c(1997, 'eq', 1997)).ok, true);
  assert.equal((await c('12', 'eq', 12)).ok, true);
  assert.equal((await c('a', 'eq', 'b')).ok, false);
  assert.equal((await c('a', 'ne', 'b')).ok, true);
  assert.equal((await c(3, 'gt', 2)).ok, true);
  assert.equal((await c(2, 'gt', 2)).ok, false);
  assert.equal((await c(2, 'gte', 2)).ok, true);
  assert.equal((await c(1, 'lt', 2)).ok, true);
  assert.equal((await c(3, 'lte', 2)).ok, false);
  assert.equal((await c('Pride and Prejudice', 'contains', 'Prejudice')).ok, true);
  assert.equal((await c([1, 2], 'contains', 2)).ok, true);
  assert.deepEqual((await c(1, 'eq', 2)).evidence, { left: 1, op: 'eq', right: 2 });
  await assert.rejects(c(1, 'bogus', 1), /Unknown op/);
  await assert.rejects(c('x', 'gt', 1), /numbers/);
});

test('fs.countFiles: glob, non-recursive and recursive', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'cf-'));
  await mkdir(path.join(d, 'sub'));
  for (const f of ['a.txt', 'b.txt', 'c.md', 'sub/d.txt']) await writeFile(path.join(d, f), 'x');
  const count = async (args) => (await actions['fs.countFiles'](args, {})).value;
  assert.equal(await count({ dir: d, glob: '*.txt' }), 2);
  assert.equal(await count({ dir: d, glob: '*.txt', recursive: true }), 3);
  assert.equal(await count({ dir: d }), 3);
});

// ---- v2 additions ----
import { readFile, readdir } from 'node:fs/promises';
import { parseCsv } from '../src/actions/pg.js';
import { cell, table, capIo, mask } from '../src/actions/io.js';
import { checkRelataRead, discoverToken } from '../src/actions/relata.js';
import { checkIndex } from '../src/actions/es.js';
import { request } from '../src/actions/http.js';
import { parseSummary as ps } from '../src/actions/openetl.js';

test('parseCsv handles header, quotes, commas and newlines', () => {
  const r = parseCsv('a,b\n1,"x, ""y"""\n2,"line1\nline2"\n');
  assert.deepEqual(r.columns, ['a', 'b']);
  assert.deepEqual(r.rows, [['1', 'x, "y"'], ['2', 'line1\nline2']]);
  assert.deepEqual(parseCsv('count\n'), { columns: ['count'], rows: [] });
  assert.deepEqual(parseCsv(''), { columns: [], rows: [] });
});

test('io helpers cap rows, cells and total size', () => {
  assert.equal(cell('x'.repeat(300)).length, 203);
  assert.equal(cell(null), null);
  const t = table(['a'], Array.from({ length: 30 }, (_, i) => [i]));
  assert.equal(t.rows.length, 20);
  assert.equal(t.rowCount, 30);
  assert.equal(t.truncated, true);
  const big = capIo({ kind: 'sql', request: {}, response: table(['a'], Array.from({ length: 20 }, () => ['y'.repeat(200)])) });
  assert.ok(JSON.stringify(big).length <= 8000);
  assert.equal(mask('Bearer abc123 x abc123', 'abc123'), 'Bearer *** x ***');
});

test('relata statements: only one SELECT or HYBRID_SEARCH', () => {
  assert.equal(checkRelataRead('SELECT 1;'), 'SELECT 1');
  assert.ok(checkRelataRead("HYBRID_SEARCH FROM DocumentChunk QUERY 'x' LIMIT 5"));
  for (const bad of ['DELETE FROM x', 'select 1; select 2', 'INSERT INTO x', '']) assert.throws(() => checkRelataRead(bad), undefined, bad);
});

test('relata token comes from env and is never needed in io', async () => {
  const old = process.env.RELATA_TOKEN;
  process.env.RELATA_TOKEN = 'tok-123';
  try { assert.equal(await discoverToken({}), 'tok-123'); } finally { if (old === undefined) delete process.env.RELATA_TOKEN; else process.env.RELATA_TOKEN = old; }
});

test('es index names and http host allowlist', async () => {
  assert.equal(checkIndex('wiki_pages'), 'wiki_pages');
  for (const bad of ['', 'A', '../x', 'a b', 'a/b']) assert.throws(() => checkIndex(bad), undefined, bad);
  await assert.rejects(request('GET', 'http://example.com/'), /not allowed/);
});

test('docker.stop and docker.start refuse every container except openetl-lab-postgres', async () => {
  for (const k of ['docker.stop', 'docker.start']) {
    await assert.rejects(actions[k]({ container: 'openetl-lab-mongodb' }, {}), /not allowed/);
    await assert.rejects(actions[k]({ container: 'openetl-relata' }, {}), /not allowed/);
  }
});

test('check.missing lists absent items', async () => {
  const r = await actions['check.missing']({ expected: ['a', 'b', 'c'], actual: ['a', 'c'] }, {});
  assert.equal(r.ok, false);
  assert.deepEqual(r.value, ['b']);
  assert.equal((await actions['check.missing']({ expected: ['a'], actual: ['a', 'z'] }, {})).ok, true);
  assert.equal((await actions['check.compare']({ left: 1, op: 'eq', right: 1 }, {})).io.kind, 'compare');
});

test('fs.countCsvRows and fs.list', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'csv-'));
  await writeFile(path.join(d, 'a.csv'), 'h1,h2\n1,2\n3,4\n');
  await writeFile(path.join(d, 'b.txt'), 'x');
  assert.equal((await actions['fs.countCsvRows']({ file: path.join(d, 'a.csv') }, {})).value, 2);
  assert.deepEqual((await actions['fs.list']({ dir: d, glob: '*.csv' }, {})).value, ['a.csv']);
});

test('fixture.stage writes 3 files with a unique marker and filled ids', async () => {
  const r = await actions['fixture.stage']({ name: 's02' }, {});
  assert.match(r.value.marker, /^S02-/);
  const files = (await readdir(r.value.dir)).sort();
  assert.equal(files.length, 3);
  const text = await readFile(path.join(r.value.dir, files[0]), 'utf8');
  assert.ok(text.includes(r.value.marker));
  assert.ok(!text.includes('{{'));
  assert.equal(r.value.eid1.length, 12);
  await assert.rejects(actions['fixture.stage']({ name: '../x' }, {}), /Invalid fixture/);
});

test('scenario files are v2: summary, flow, explain per step, known actions, unique step ids', async () => {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../scenarios');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const s = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    assert.ok(s.summary && s.tracker_row && s.resources?.length, f);
    for (const k of ['source', 'engine', 'target']) assert.ok(s.flow?.[k]?.label, `${f} flow.${k}`);
    const ids = new Set();
    for (const st of s.steps) {
      assert.ok(st.explain, `${f}:${st.id} explain`);
      assert.equal(typeof actions[st.action], 'function', `${f}:${st.id} action ${st.action}`);
      assert.ok(!ids.has(st.id), `${f} duplicate step ${st.id}`);
      ids.add(st.id);
    }
  }
});
