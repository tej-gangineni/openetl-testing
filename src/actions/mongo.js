// MongoDB actions (S07). Runs mongosh inside the allow-listed lab container.
import { execFile } from 'node:child_process';
import { table, capIo } from './io.js';

const CONTAINER = 'openetl-lab-mongodb';
const DB = 'openetl';
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function checkName(n, what = 'collection') {
  if (typeof n !== 'string' || !NAME_RE.test(n)) throw new Error(`Invalid ${what} name: ${JSON.stringify(n)}`);
  return n;
}
function checkField(f) {
  if (typeof f !== 'string' || !FIELD_RE.test(f)) throw new Error(`Invalid field name: ${JSON.stringify(f)}`);
  return f;
}
// Filter is plain JSON; operators allowed, server-side JS ($where, $function, $accumulator) refused.
function checkFilter(filter = {}) {
  const s = JSON.stringify(filter);
  if (typeof filter !== 'object' || filter === null || /"\$(where|function|accumulator|expr)"/.test(s)) throw new Error('Filter not allowed');
  return s;
}

async function getConfig(ctx) {
  if (ctx?.config) return ctx.config;
  const m = await import('../config.js');
  return m.default ?? m.config ?? m;
}

async function mongosh(script, ctx) {
  const cfg = await getConfig(ctx);
  if (!cfg.allowedContainers.includes(CONTAINER)) throw new Error(`Container not allowed: ${CONTAINER}`);
  const full = `const d=db.getSiblingDB(${JSON.stringify(DB)});${script}`;
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', CONTAINER, 'mongosh', '--quiet', '--eval', full],
      { maxBuffer: 16 * 1024 * 1024, signal: ctx?.signal, timeout: 60000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`mongosh in ${CONTAINER} failed: ${(stderr || err.message).trim()}`));
        resolve(stdout.trim());
      });
  });
}

const show = (script) => `db.getSiblingDB("${DB}")` + script;
const io = (text, columns, rows) => capIo({ kind: 'sql', request: { target: CONTAINER, text }, response: table(columns, rows) });

async function dropCollection({ collection }, ctx) {
  checkName(collection);
  const text = `${show(`.${collection}.drop()`)}`;
  await mongosh(`d.getCollection(${JSON.stringify(collection)}).drop()`, ctx);
  ctx?.log?.(`Dropped collection ${collection} (if it existed)`);
  return { value: collection, evidence: { dropped: collection }, io: io(text, ['result'], [['dropped']]) };
}

async function count({ collection, filter = {} }, ctx) {
  checkName(collection);
  const f = checkFilter(filter);
  const text = `${show(`.${collection}.countDocuments(${f})`)}`;
  ctx?.log?.(text);
  const out = await mongosh(`print(d.getCollection(${JSON.stringify(collection)}).countDocuments(${f}))`, ctx);
  const value = Number(out);
  if (Number.isNaN(value)) throw new Error(`Unexpected count output: ${out}`);
  return { value, evidence: { collection, filter, value }, io: io(text, ['count'], [[value]]) };
}

// Returns the first `limit` (max 20) documents, projected to `fields`, as table rows.
async function find({ collection, filter = {}, fields, limit = 20, sort }, ctx) {
  checkName(collection);
  const f = checkFilter(filter);
  const lim = Math.min(Math.max(1, Number(limit) || 20), 20);
  const cols = fields?.length ? fields.map(checkField) : null;
  const proj = cols ? JSON.stringify(Object.fromEntries([['_id', 0], ...cols.map((c) => [c, 1])])) : '{}';
  const srt = sort ? JSON.stringify({ [checkField(sort)]: 1 }) : '{}';
  const text = `${show(`.${collection}.find(${f}, ${proj}).sort(${srt}).limit(${lim})`)}`;
  ctx?.log?.(text);
  const script = `print(JSON.stringify(d.getCollection(${JSON.stringify(collection)}).find(${f},${proj}).sort(${srt}).limit(${lim}).toArray()))`;
  const docs = JSON.parse((await mongosh(script, ctx)) || '[]');
  const columns = cols ?? [...new Set(docs.flatMap((x) => Object.keys(x)))];
  const rows = docs.map((x) => columns.map((c) => c.split('.').reduce((a, k) => (a == null ? a : a[k]), x) ?? null));
  return { value: rows, evidence: { collection, rowCount: rows.length, rows }, io: io(text, columns, rows) };
}

// Counts documents that have `field` and how many distinct values it has.
async function distinct({ collection, field }, ctx) {
  checkName(collection);
  checkField(field);
  const text = `${show(`.${collection}.distinct(${JSON.stringify(field)})`)}`;
  ctx?.log?.(text);
  const script = `const c=d.getCollection(${JSON.stringify(collection)});print(JSON.stringify({n:c.distinct(${JSON.stringify(field)}).length,present:c.countDocuments({${JSON.stringify(field)}:{$exists:true}})}))`;
  const r = JSON.parse(await mongosh(script, ctx));
  return { value: r.n, evidence: { collection, field, distinct: r.n, present: r.present }, io: io(text, ['distinct', 'docs_with_field'], [[r.n, r.present]]) };
}

export default {
  'mongo.dropCollection': dropCollection,
  'mongo.count': count,
  'mongo.find': find,
  'mongo.distinct': distinct,
};
