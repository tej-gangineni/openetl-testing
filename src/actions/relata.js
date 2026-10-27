import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HOSTS, request } from './http.js';
import { table, capIo, mask } from './io.js';

function sh(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 10000 }, (e, out) => resolve(e ? '' : out)));
}

// Find the bearer token without ever printing it. Order: env, running relata process, openetl repo .env.
export async function discoverToken(ctx) {
  if (process.env.RELATA_TOKEN) return process.env.RELATA_TOKEN;
  const pids = (await sh('pgrep', ['-f', 'relata serve'])).split('\n').filter(Boolean);
  for (const pid of pids) {
    const m = (await sh('ps', ['e', '-p', pid])).match(/RELATA_BEARER_TOKEN=(\S+)/);
    if (m) return m[1];
  }
  const repo = ctx?.vars?.repo ?? ctx?.config?.repo;
  if (repo) {
    try {
      const m = (await readFile(path.join(repo, '.env'), 'utf8')).match(/^RELATA_TOKEN=(.+)$/m);
      if (m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* no .env */ }
  }
  throw new Error('Relata token not found: set RELATA_TOKEN, run `relata serve` locally, or put RELATA_TOKEN in the openetl repo .env');
}

export function relataUrl() { return HOSTS.relata; }

// Run one read-only statement. Relata statements are SQL-like (SELECT, HYBRID_SEARCH, ...); anything that is not a read is refused.
export function checkRelataRead(sql) {
  if (typeof sql !== 'string') throw new Error('Statement must be a string');
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!/^(select|hybrid_search)\b/i.test(s)) throw new Error('Only SELECT or HYBRID_SEARCH statements are allowed');
  if (s.includes(';')) throw new Error('Only a single statement is allowed (found ";")');
  return s;
}

export async function relataQuery({ sql, purpose = 'investigation' }, ctx) {
  const s = checkRelataRead(sql);
  const token = await discoverToken(ctx);
  ctx?.log?.(s);
  const url = `${HOSTS.relata}/query`;
  const res = await request('POST', url, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sql: s, purpose }), signal: ctx?.signal,
  });
  const safe = mask(res.text, token);
  if (res.status !== 200) throw new Error(`Relata error ${res.status}: ${safe.slice(0, 300)}`);
  const json = JSON.parse(res.text);
  const columns = json.columns ?? (json.data?.[0] ? Object.keys(json.data[0]) : []);
  const objs = json.data ?? json.rows ?? [];
  const rows = objs.map((o) => columns.map((c) => o[c]));
  return {
    value: objs,
    evidence: { sql: s, rowCount: rows.length, rows: rows.slice(0, 5).map((r) => r.map((c) => (typeof c === 'string' ? c.slice(0, 80) : c))) },
    io: capIo({
      kind: 'sql',
      request: { target: `relata ${HOSTS.relata}/query`, text: s, headers: { Authorization: 'Bearer ***' } },
      response: table(columns, rows),
    }),
  };
}
