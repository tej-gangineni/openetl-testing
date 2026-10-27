import { spawn } from 'node:child_process';
import { capIo, mask } from './io.js';
import { discoverToken, relataUrl } from './relata.js';

// Strip ANSI escapes and box-drawing characters (U+2500-257F).
export function clean(line) {
  return line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[─-╿]/g, '').replace(/\s+$/, '').replace(/^\s+/, '');
}

const STATUSES = ['COMPLETED', 'PARTIAL', 'FAILED'];

// Parse the summary panel from (cleaned or raw) job output.
export function parseSummary(text) {
  const lines = text.split(/\r?\n/).map(clean);
  const out = { status: 'UNKNOWN', files: null, records: null, warnings: null, elapsedSeconds: null };
  for (const l of lines) {
    let m;
    if ((m = l.match(/openetl job run\s+\S\s+(\w+)/i))) {
      const s = m[1].toUpperCase();
      out.status = STATUSES.includes(s) ? s : 'UNKNOWN';
    } else if ((m = l.match(/^files:\s*(\d+)/))) out.files = Number(m[1]);
    else if ((m = l.match(/^records:\s*(\d+)/))) out.records = Number(m[1]);
    else if ((m = l.match(/^warnings:\s*(\d+)/))) out.warnings = Number(m[1]);
    else if ((m = l.match(/^elapsed:\s*([\d.]+)s/))) out.elapsedSeconds = Number(m[1]);
  }
  return out;
}

const WARN_LINE = /\b(warn(ing)?s?|quarantin\w*|skipp\w*|error|failed|fail)\b/i;
const NOISE = /^=+|^\[(CHUNKER-DEBUG|X5-GUARD)|^warnings$|^warnings:\s*0\b|^records:|^✔ Job|COMPLETED$/;

// Start `uv run ... openetl job run`. Returns { done: Promise<result> }; lines go to onLine.
// args.env: extra environment; args.relata: true injects RELATA_URL and RELATA_TOKEN (token is masked everywhere).
async function start({ pipeline, cwd, extras = [], timeoutSec = 300, env = {}, relata = false }, ctx, onLine) {
  if (!pipeline) throw new Error('pipeline is required');
  const repo = ctx?.vars?.repo ?? ctx?.config?.repo;
  if (!repo) throw new Error('repo path is not known (ctx.vars.repo / ctx.config.repo)');
  const args = ['run', '--project', repo];
  for (const e of extras) args.push('--extra', e);
  args.push('openetl', 'job', 'run', pipeline);
  const childEnv = { ...process.env, NO_COLOR: '1', ...env };
  let token = '';
  if (relata) {
    token = await discoverToken(ctx);
    childEnv.RELATA_URL = relataUrl();
    childEnv.RELATA_TOKEN = token;
  }
  const envShown = Object.entries(env).map(([k, v]) => `${k}=${v}`).concat(relata ? [`RELATA_URL=${relataUrl()}`, 'RELATA_TOKEN=***'] : []);
  const text = `${envShown.length ? envShown.join(' ') + ' ' : ''}uv ${args.join(' ')}`;
  onLine(`$ ${text}  (cwd ${cwd ?? process.cwd()})`);

  const started = Date.now();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  ctx?.signal?.addEventListener('abort', onAbort, { once: true });
  if (ctx?.signal?.aborted) ac.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutSec * 1000);

  const all = [];
  const done = (async () => {
    const { exitCode, spawnError } = await new Promise((resolve) => {
      const child = spawn('uv', args, { cwd, signal: ac.signal, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      const feed = (stream) => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (d) => {
          buf += d;
          const parts = buf.split(/\r?\n|\r/);
          buf = parts.pop();
          for (const p of parts) emit(p);
        });
        stream.on('end', () => buf && emit(buf));
      };
      const emit = (raw) => {
        const l = mask(clean(raw), token);
        all.push(mask(raw, token));
        if (l) onLine(l);
      };
      feed(child.stdout);
      feed(child.stderr);
      child.on('error', (e) => resolve({ exitCode: null, spawnError: e }));
      child.on('close', (code) => resolve({ exitCode: code }));
    });
    clearTimeout(timer);
    ctx?.signal?.removeEventListener('abort', onAbort);
    if (timedOut) throw new Error(`openetl job run timed out after ${timeoutSec}s`);
    if (ctx?.signal?.aborted) throw new Error('openetl job run aborted');
    if (spawnError) throw new Error(`Could not start uv: ${spawnError.message}`);

    const value = { ...parseSummary(all.join('\n')), exitCode };
    value.elapsedSeconds ??= Math.round((Date.now() - started) / 100) / 10;
    // Lines that explain warnings or failures, so a Fail can show the real reason.
    value.warningLines = [...new Set(all.map(clean).filter((l) => l && !/\[SUBSTEP\]/.test(l) && !NOISE.test(l) && WARN_LINE.test(l)))].slice(0, 15).map((l) => l.slice(0, 300));
    const io = capIo({ kind: 'command', request: { text, cwd: cwd ?? process.cwd() }, response: { exitCode, summary: value } });
    return { ok: value.status === 'COMPLETED' || value.status === 'PARTIAL', value, evidence: value, io };
  })();
  return { done };
}

export async function jobRun(args, ctx) {
  const { done } = await start(args, ctx, (l) => ctx?.log?.(l));
  return done;
}

// Background runs for fault-injection scenarios: jobStart returns at once, jobWait collects the result.
const RUNS = new Map();

export async function jobStart(args, ctx) {
  const lines = [];
  const { done } = await start(args, ctx, (l) => lines.push(l));
  done.catch(() => {}); // surfaced by jobWait
  const handle = `job_${Date.now().toString(36)}_${RUNS.size}`;
  RUNS.set(handle, { done, lines });
  ctx?.log?.(`Started in the background: ${lines[0] ?? ''}`);
  return {
    value: handle, evidence: { handle },
    io: { kind: 'command', request: { text: lines[0]?.replace(/^\$ /, '').replace(/\s+\(cwd .*$/, '') ?? '', cwd: args.cwd ?? '' }, response: { exitCode: null, summary: { started: true } } },
  };
}

export async function jobWait({ handle }, ctx) {
  const run = RUNS.get(handle);
  if (!run) throw new Error(`No background job with handle ${JSON.stringify(handle)}`);
  const result = await run.done;
  RUNS.delete(handle);
  for (const l of run.lines) ctx?.log?.(l);
  return result;
}
