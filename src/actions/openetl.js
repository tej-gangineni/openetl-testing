import { spawn } from 'node:child_process';

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

export async function jobRun({ pipeline, cwd, extras = [], timeoutSec = 300 }, ctx) {
  if (!pipeline) throw new Error('pipeline is required');
  const repo = ctx?.vars?.repo ?? ctx?.config?.repo;
  if (!repo) throw new Error('repo path is not known (ctx.vars.repo / ctx.config.repo)');
  const args = ['run', '--project', repo];
  for (const e of extras) args.push('--extra', e);
  args.push('openetl', 'job', 'run', pipeline);
  ctx?.log?.(`$ uv ${args.join(' ')}  (cwd ${cwd ?? process.cwd()})`);

  const started = Date.now();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  ctx?.signal?.addEventListener('abort', onAbort, { once: true });
  if (ctx?.signal?.aborted) ac.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutSec * 1000);

  const all = [];
  const { exitCode, spawnError } = await new Promise((resolve) => {
    const child = spawn('uv', args, { cwd, signal: ac.signal, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let exit = null;
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
      const l = clean(raw);
      all.push(raw);
      if (l) ctx?.log?.(l);
    };
    feed(child.stdout);
    feed(child.stderr);
    child.on('error', (e) => resolve({ exitCode: null, spawnError: e }));
    child.on('close', (code) => resolve({ exitCode: code ?? exit }));
  });
  clearTimeout(timer);
  ctx?.signal?.removeEventListener('abort', onAbort);

  if (timedOut) throw new Error(`openetl job run timed out after ${timeoutSec}s`);
  if (ctx?.signal?.aborted) throw new Error('openetl job run aborted');
  if (spawnError) throw new Error(`Could not start uv: ${spawnError.message}`);

  const value = { ...parseSummary(all.join('\n')), exitCode };
  value.elapsedSeconds ??= Math.round((Date.now() - started) / 100) / 10;
  return { ok: value.status === 'COMPLETED' || value.status === 'PARTIAL', value, evidence: value };
}
