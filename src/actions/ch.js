import { HOSTS, request } from './http.js';
import { checkSelect, checkTable } from './pg.js';
import { table, capIo } from './io.js';

const AUTH = { 'X-ClickHouse-User': 'lab', 'X-ClickHouse-Key': 'lab' };
const DB = 'openetl';

async function query(sql, { readonly = true, signal } = {}) {
  const qs = new URLSearchParams({ database: DB, default_format: 'JSONCompact' });
  if (readonly) qs.set('readonly', '1');
  const res = await request('POST', `${HOSTS.clickhouse}/?${qs}`, { headers: AUTH, body: sql, signal });
  if (res.status !== 200) throw new Error(`ClickHouse error ${res.status}: ${res.text.trim().slice(0, 300)}`);
  return res.text ? JSON.parse(res.text) : { meta: [], data: [] };
}

async function select(sql, ctx) {
  const s = checkSelect(sql);
  ctx?.log?.(s);
  const r = await query(s, { signal: ctx?.signal });
  return { s, columns: r.meta.map((m) => m.name), rows: r.data };
}

const ioFor = (s, columns, rows) => capIo({
  kind: 'sql',
  request: { target: `clickhouse ${HOSTS.clickhouse}/${DB} (read-only)`, text: s },
  response: table(columns, rows),
});

export async function chRows({ sql }, ctx) {
  const { s, columns, rows } = await select(sql, ctx);
  return { value: rows, evidence: { sql: s, rowCount: rows.length, rows: rows.slice(0, 20) }, io: ioFor(s, columns, rows) };
}

export async function chScalar({ sql }, ctx) {
  const { s, columns, rows } = await select(sql, ctx);
  if (rows.length !== 1 || rows[0].length !== 1) throw new Error(`Expected one row with one column, got ${rows.length} row(s)`);
  let value = rows[0][0];
  if (typeof value === 'string' && value !== '' && !isNaN(Number(value))) value = Number(value);
  return { value, evidence: { sql: s, value }, io: ioFor(s, columns, rows) };
}

// The one write: DROP TABLE of a validated table name.
export async function chDropTable({ table: name }, ctx) {
  checkTable(name);
  const text = `DROP TABLE IF EXISTS ${name}`;
  await query(text, { readonly: false, signal: ctx?.signal });
  ctx?.log?.(`Dropped ClickHouse table ${name} (if it existed)`);
  return {
    value: name, evidence: { dropped: name },
    io: { kind: 'sql', request: { target: `clickhouse ${HOSTS.clickhouse}/${DB}`, text }, response: table(['result'], [['ok']]) },
  };
}
