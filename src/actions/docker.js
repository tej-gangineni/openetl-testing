import { execFile } from 'node:child_process';

// Only this one container may be stopped or started.
export const CONTAINER = 'openetl-lab-postgres';

function docker(args, signal) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 90000, signal }, (e, out, err) => (e ? reject(new Error(`docker ${args[0]} failed: ${(err || e.message).trim()}`)) : resolve(out.trim())));
  });
}

function guard(container) {
  if (container !== CONTAINER) throw new Error(`Container not allowed for stop/start: ${container}`);
}

async function state(container) {
  const out = await docker(['inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', container]);
  const [status, health] = out.split(' ');
  return { status, health };
}

const io = (container, op, ok, st) => ({ kind: 'docker', request: { container, op }, response: { ok, state: st } });

export async function dockerStop({ container = CONTAINER }, ctx) {
  guard(container);
  await docker(['stop', container], ctx?.signal);
  const st = await state(container);
  ctx?.log?.(`Stopped ${container}: ${st.status}`);
  return { ok: st.status !== 'running', value: st, evidence: { container, ...st }, io: io(container, 'stop', st.status !== 'running', st.status) };
}

export async function dockerStart({ container = CONTAINER, timeoutSec = 60 }, ctx) {
  guard(container);
  await docker(['start', container], ctx?.signal);
  const deadline = Date.now() + timeoutSec * 1000;
  let st = await state(container);
  while (!(st.status === 'running' && (st.health === 'healthy' || st.health === 'none')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    st = await state(container);
  }
  const ok = st.status === 'running' && (st.health === 'healthy' || st.health === 'none');
  ctx?.log?.(`Started ${container}: ${st.status}/${st.health}`);
  return { ok, value: st, evidence: { container, ...st }, io: io(container, 'start', ok, `${st.status}/${st.health}`) };
}
