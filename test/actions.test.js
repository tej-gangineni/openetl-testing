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
