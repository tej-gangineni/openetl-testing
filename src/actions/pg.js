import { execFile } from 'node:child_process';
import { table, capIo } from './io.js';

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

export function checkTable(name) {
  if (typeof name !== 'string' || !TABLE_RE.test(name)) throw new Error(`Invalid table name: ${JSON.stringify(name)}`);
  return name;
}

// Accepts exactly one SELECT; returns it without the trailing semicolon.
export function checkSelect(sql) {
  if (typeof sql !== 'string') throw new Error('SQL must be a string');
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(s)) throw new Error('Only a single SELECT statement is allowed');
  if (s.includes(';')) throw new Error('Only a single SELECT statement is allowed (found ";")');
  if (/--|\/\*/.test(s)) throw new Error('SQL comments are not allowed');
  if (/\binto\b/i.test(s)) throw new Error('SELECT ... INTO is not allowed');
  return s;
}

async function getConfig(ctx) {
  if (ctx?.config) return ctx.config;
  const m = await import('../config.js');
  return m.default ?? m.config ?? m;
}

async function psql(sql, ctx) {
  const cfg = await getConfig(ctx);
  const { container, user, db } = cfg.pg;
  if (!cfg.allowedContainers.includes(container)) throw new Error(`Container not allowed: ${container}`);
  const args = ['exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', container,
    'psql', '-U', user, '-d', db, '--csv', '-v', 'ON_ERROR_STOP=1', '-c', sql];
  return run(args, ctx, container);
}

function run(args, ctx, container) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 16 * 1024 * 1024, signal: ctx?.signal, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`psql in ${container} failed: ${(stderr || err.message).trim()}`));
      resolve(stdout);
    });
  });
}

// Parse psql --csv output (header row first; quoted cells may contain commas, quotes and newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    any = true;
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; any = false; }
    else if (c !== '\r') cur += c;
  }
  if (any) { row.push(cur); rows.push(row); }
  return { columns: rows[0] ?? [], rows: rows.slice(1) };
}

const ioFor = (container, sql, columns, rows) => capIo({
  kind: 'sql', request: { target: container, text: sql }, response: table(columns, rows),
});

export async function dropTable({ table }, ctx) {
  checkTable(table);
  const cfg = await getConfig(ctx);
  const { container, user, db } = cfg.pg;
  if (!cfg.allowedContainers.includes(container)) throw new Error(`Container not allowed: ${container}`);
  // DROP is the one write we allow, so this call skips the read-only guard.
  await run(['exec', container, 'psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', `DROP TABLE IF EXISTS "${table}"`], ctx, container);
  ctx?.log?.(`Dropped table ${table} (if it existed)`);
  return {
    value: table, evidence: { dropped: table },
    io: { kind: 'sql', request: { target: container, text: `DROP TABLE IF EXISTS "${table}"` }, response: { columns: ['result'], rows: [['DROP TABLE']], rowCount: 1, truncated: false } },
  };
}

export async function scalar({ sql }, ctx) {
  const s = checkSelect(sql);
  ctx?.log?.(s);
  const cfg = await getConfig(ctx);
  const r = parseCsv(await psql(s, ctx));
  if (r.rows.length !== 1 || r.columns.length !== 1) throw new Error(`Expected one row with one column, got ${r.rows.length} row(s)`);
  const raw = r.rows[0][0];
  const value = raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw;
  return { value, evidence: { sql: s, value }, io: ioFor(cfg.pg.container, s, r.columns, r.rows) };
}

// tolerateMissing: a "relation does not exist" error returns zero rows (used for the Before read of a dropped table).
export async function rows({ sql, tolerateMissing = false }, ctx) {
  const s = checkSelect(sql);
  ctx?.log?.(s);
  const cfg = await getConfig(ctx);
  let r;
  try {
    r = parseCsv(await psql(s, ctx));
  } catch (e) {
    if (!tolerateMissing || !/does not exist/.test(e.message)) throw e;
    ctx?.log?.('Table does not exist yet: 0 rows');
    r = { columns: [], rows: [] };
  }
  return { value: r.rows, evidence: { sql: s, rowCount: r.rows.length, rows: r.rows.slice(0, 20) }, io: ioFor(cfg.pg.container, s, r.columns, r.rows) };
}
