import { execFile } from 'node:child_process';

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;
const SEP = '\t';

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
    'psql', '-U', user, '-d', db, '-At', '-F', SEP, '-v', 'ON_ERROR_STOP=1', '-c', sql];
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

function parseRows(out) {
  return out.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).map((l) => l.split(SEP));
}

export async function dropTable({ table }, ctx) {
  checkTable(table);
  const cfg = await getConfig(ctx);
  const { container, user, db } = cfg.pg;
  if (!cfg.allowedContainers.includes(container)) throw new Error(`Container not allowed: ${container}`);
  // DROP is the one write we allow, so this call skips the read-only guard.
  await run(['exec', container, 'psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', `DROP TABLE IF EXISTS "${table}"`], ctx, container);
  ctx?.log?.(`Dropped table ${table} (if it existed)`);
  return { value: table, evidence: { dropped: table } };
}

export async function scalar({ sql }, ctx) {
  const s = checkSelect(sql);
  ctx?.log?.(s);
  const r = parseRows(await psql(s, ctx));
  if (r.length !== 1 || r[0].length !== 1) throw new Error(`Expected one row with one column, got ${r.length} row(s)`);
  const raw = r[0][0];
  const value = raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw;
  return { value, evidence: { sql: s, value } };
}

export async function rows({ sql }, ctx) {
  const s = checkSelect(sql);
  ctx?.log?.(s);
  const r = parseRows(await psql(s, ctx));
  return { value: r, evidence: { sql: s, rowCount: r.length, rows: r.slice(0, 20) } };
}
