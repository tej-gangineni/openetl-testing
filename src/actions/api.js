// Actions that drive the running OpenETL master over its HTTP API (127.0.0.1:8080):
// submit a job, wait for its run, read runs/status/connectors, and call the source test
// and destination check endpoints. Every action returns io.kind 'http' with secrets masked.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTS, request } from './http.js';
import { cut, capIo, mask } from './io.js';
import { discoverToken } from './relata.js';
import { resolve as fillTemplate } from '../template.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TERMINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'CANCELED', 'ERROR'];
const SECRET_KEY = /(token|password|passwd|secret|api_key|apikey|auth|credential|private_key)/i;

// ---------- pure helpers (unit tested) ----------

export function upperStatus(s) {
  if (s === null || s === undefined || s === '') return 'UNKNOWN';
  return String(s).trim().toUpperCase();
}

export function isTerminal(s) {
  return TERMINAL.includes(upperStatus(s));
}

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? null : t;
};

// The run this wait is about: by run_id when known, else the newest run of `name`
// that started at or after `after` (1 s slack for clock rounding).
export function pickRun(runs, { name, after, runId, slackMs = 1000 } = {}) {
  if (!Array.isArray(runs)) return null;
  if (runId) return runs.find((r) => r.run_id === runId) ?? null;
  const since = after ? ms(after) - slackMs : -Infinity;
  const mine = runs.filter((r) => r.job_name === name && (ms(r.started_at) ?? -Infinity) >= since);
  mine.sort((a, b) => (ms(b.started_at) ?? 0) - (ms(a.started_at) ?? 0));
  return mine[0] ?? null;
}

// Flatten a run record (and/or a task result) into the numbers scenarios compare.
export function runSummary(run, task) {
  const m = run?.manifest ?? {};
  const sinks = Array.isArray(m.sinks) ? m.sinks.map((s) => ({ sink: s.sink, type: s.type, delivered: s.delivered ?? null, failed: s.failed ?? null, error: s.error ?? null })) : [];
  const status = upperStatus(run?.status ?? task?.status);
  return {
    status,
    run_id: run?.run_id ?? task?.run_id ?? null,
    files: m.total_files ?? task?.total_files ?? null,
    records: m.total_records ?? task?.total_records ?? null,
    delivered: m.records_delivered ?? task?.records_delivered ?? null,
    failed: m.records_failed ?? task?.records_failed ?? null,
    warnings: m.total_warnings ?? task?.total_warnings ?? null,
    nothing_extracted: m.nothing_extracted ?? null,
    sinks,
    sinkCount: sinks.length,
    error: run?.error ?? task?.error ?? null,
    started_at: run?.started_at ?? null,
    completed_at: run?.completed_at ?? null,
    startedMs: ms(run?.started_at),
    completedMs: ms(run?.completed_at),
    elapsed_s: m.elapsed_s ?? task?.elapsed_s ?? null,
    // |(completed - started) - elapsed_s| in ms: how far the manifest duration is from the record's own times.
    elapsedGapMs: ms(run?.started_at) !== null && ms(run?.completed_at) !== null && typeof (m.elapsed_s ?? task?.elapsed_s) === 'number'
      ? Math.round(Math.abs(ms(run.completed_at) - ms(run.started_at) - (m.elapsed_s ?? task.elapsed_s) * 1000)) : null,
    hasRunRecord: !!run,
    taskStatus: task ? upperStatus(task.status) : null,
  };
}

// The worker could not load a sink or source driver: the environment is missing a package,
// so the step cannot test what it meant to test (Blocked, not Fail).
export function envProblem(text) {
  const s = String(text ?? '');
  const m = s.match(/([\w-]+ not installed[^\n]*|Install openetl\[[\w-]+\][^\n]*|No module named [^\n]+)/i);
  return m ? m[1].slice(0, 300) : null;
}

// Replace secret values in free text: TOML/JSON secret keys, key=value pairs, URL passwords, and given literals.
export function maskSecrets(text, literals = []) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const l of literals) if (l && String(l).length >= 3) out = mask(out, String(l));
  out = out.replace(/^(\s*[\w.-]*(?:token|password|passwd|secret|api_key|apikey|credential)[\w.-]*\s*=\s*)(["'])(.*?)\2/gim, (_, k, q) => `${k}${q}***${q}`);
  out = out.replace(/("[\w.-]*(?:token|password|passwd|secret|api_key|apikey|credential)[\w.-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"');
  out = out.replace(/\b(password|passwd|pwd)=('[^']*'|[^\s"&]+)/gi, '$1=***');
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@"]+):([^@\s"/]+)@/gi, '$1:***@');
  return out;
}

// A copy of a request body object with secret-keyed values and DSN passwords hidden.
export function maskObject(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => maskObject(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskObject(x, k)]));
  if (typeof v === 'string') return SECRET_KEY.test(key) ? '***' : maskSecrets(v);
  return v;
}

// ---------- transport ----------

let realToken; // the Relata bearer token, only ever used to mask it
async function tokenToMask(ctx) {
  if (realToken !== undefined) return realToken;
  try { realToken = await discoverToken(ctx); } catch { realToken = ''; }
  return realToken;
}

async function call(method, apiPath, body, ctx, { shownBody } = {}) {
  if (!/^\/[\w/.\-?=&%]*$/.test(apiPath ?? '')) throw new Error(`Invalid API path: ${JSON.stringify(apiPath)}`);
  const url = `${HOSTS.openetl}${apiPath}`;
  const res = await request(method, url, {
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: ctx?.signal,
  });
  const tok = await tokenToMask(ctx);
  const text = mask(res.text, tok);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const io = capIo({
    kind: 'http',
    request: { method, url, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: shownBody ?? (body !== undefined ? maskObject(body) : null) },
    response: { status: res.status, body: cut(maskSecrets(text), 4096) },
  });
  ctx?.log?.(`${method} ${apiPath} -> HTTP ${res.status}`);
  return { status: res.status, json, text, io };
}

// ---------- actions ----------

// GET any API path. ok: status < 400, or status === expectStatus when given.
export async function apiGet({ path: p, expectStatus }, ctx) {
  const { status, json, text, io } = await call('GET', p, undefined, ctx);
  const ok = expectStatus !== undefined ? status === Number(expectStatus) : status < 400;
  return { ok, value: { status, body: json, raw: text }, evidence: { path: p, status, ...(expectStatus !== undefined ? { expectStatus } : {}) }, io };
}

// Read the TOML (inline or from a file under this repo), fill ${lab} and other variables.
export async function loadSpec({ spec, specFile, vars = {} }, ctx) {
  let text = spec;
  if (specFile) {
    const file = path.resolve(ROOT, specFile);
    if (!file.startsWith(ROOT + path.sep)) throw new Error(`specFile must be inside this repo: ${specFile}`);
    text = await readFile(file, 'utf8');
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('spec or specFile is required');
  return fillTemplate(text, { ...(ctx?.vars ?? {}), ...vars });
}

// POST /api/v1/jobs with the TOML base64-encoded (what the console sends). value.submittedAt marks "after".
export async function submitJob({ spec, specFile, name, vars, encoding = 'base64' }, ctx) {
  if (!name) throw new Error('name is required');
  const toml = await loadSpec({ spec, specFile, vars }, ctx);
  const tok = await tokenToMask(ctx);
  const shownToml = maskSecrets(mask(toml, tok));
  const payload = { spec: encoding === 'raw' ? toml : Buffer.from(toml, 'utf8').toString('base64'), name };
  const submittedAt = new Date().toISOString();
  const { status, json, text, io } = await call('POST', '/api/v1/jobs', payload, ctx, {
    shownBody: { name, spec: `(${encoding}) ${shownToml}` },
  });
  const taskIds = json?.task_ids ?? [];
  const value = { httpStatus: status, task_ids: taskIds, taskId: taskIds[0] ?? null, submitted: json?.submitted ?? 0, submittedAt, submittedMs: Date.parse(submittedAt), name, raw: text };
  ctx?.log?.(`Submitted ${name}: ${taskIds.length} task(s) ${taskIds.join(', ')}`);
  return { ok: status === 200 && taskIds.length > 0, value, evidence: { name, httpStatus: status, task_ids: taskIds, submittedAt }, io };
}

const pause = (n, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, n);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

// Poll until the run is terminal. Uses the task result when a taskId is given (a job that fails while
// building its sinks has a task result but no run record), else the newest run of `name` after `after`.
export async function waitRun({ name, after, taskId, timeoutSec = 300, pollMs = 1000, allowEnvFailure = false }, ctx) {
  const deadline = Date.now() + timeoutSec * 1000;
  let task = null;
  let run = null;
  let lastIo;
  while (Date.now() < deadline) {
    if (taskId) {
      const t = await call('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`, undefined, ctx);
      if (t.status === 200 && t.json && isTerminal(t.json.status)) { task = t.json; lastIo = t.io; }
    }
    if (!taskId || task) {
      const r = await call('GET', '/api/v1/runs?limit=50', undefined, ctx);
      lastIo = lastIo ?? r.io;
      run = pickRun(r.json?.runs, { name, after, runId: task?.run_id });
      if (run && !isTerminal(run.status)) run = null;
      if (task && !task.run_id) break; // failed before a run record was written
      if (run) { if (!task) lastIo = r.io; break; }
    }
    await pause(pollMs, ctx?.signal);
  }
  if (!task && !run) throw new Error(`No terminal run of ${name} after ${after ?? 'submit'} within ${timeoutSec}s`);
  const value = runSummary(run, task);
  const tok = await tokenToMask(ctx);
  value.raw = mask(JSON.stringify({ run, task }), tok);
  const env = envProblem(value.error) ?? value.sinks.map((s) => envProblem(s.error)).find(Boolean);
  if (env && !allowEnvFailure) {
    throw new Error(`Environment: the OpenETL worker cannot load a driver this job needs (${env}). Start the worker with the matching uv --extra and re-run.`);
  }
  ctx?.log?.(`Run ${value.run_id ?? '(no run record)'}: ${value.status} files=${value.files} records=${value.records} delivered=${value.delivered} failed=${value.failed}${value.error ? ` error=${String(value.error).slice(0, 200)}` : ''}`);
  const shown = { status: value.status, run_id: value.run_id, files: value.files, records: value.records, delivered: value.delivered, failed: value.failed, sinks: value.sinks, error: value.error ? String(value.error).slice(0, 400) : null, started_at: value.started_at, completed_at: value.completed_at, hasRunRecord: value.hasRunRecord };
  const io = capIo({ ...(lastIo ?? { kind: 'http', request: {} }), response: { status: 200, body: cut(mask(JSON.stringify(run ?? task), tok), 4096) } });
  return { ok: true, value, evidence: shown, io };
}

async function check(apiPath, body, ctx) {
  const { status, json, text, io } = await call('POST', apiPath, body, ctx);
  const value = { httpStatus: status, ...(json ?? {}), raw: text };
  return { ok: status === 200, value, evidence: { httpStatus: status, ok: json?.ok, stage: json?.stage, level: json?.level, message: json?.message ?? json?.error }, io };
}

export async function sourceTest({ body }, ctx) {
  return check('/api/v1/sources/test', body, ctx);
}

export async function destinationCheck({ body }, ctx) {
  return check('/api/v1/destinations/check', body, ctx);
}

export default {
  'openetl.api.get': apiGet,
  'openetl.api.submitJob': submitJob,
  'openetl.api.waitRun': waitRun,
  'openetl.api.sourceTest': sourceTest,
  'openetl.api.destinationCheck': destinationCheck,
};
