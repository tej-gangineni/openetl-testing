import crypto from 'node:crypto';
import { resolve, resolveLenient } from './template.js';

const MAX_EVIDENCE = 8 * 1024;
const MAX_IO = 8 * 1024;
// Info lines: up to 400 in full, beyond that 200 head + 200 tail. Detail lines: 100 head + 100 tail.
const CAPS = { info: { head: 200, tail: 200 }, detail: { head: 100, tail: 100 } };
const ALWAYS_TIMEOUT_MS = 60_000;

export function makeRunId() {
  const d = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `r_${d}_${crypto.randomBytes(2).toString('hex')}`;
}

function abortError(signal) {
  const r = signal.reason;
  return r instanceof Error ? r : new Error(typeof r === 'string' ? r : 'Run was aborted.');
}

// Rejects as soon as the signal aborts, so an action that ignores the signal cannot hang the run.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((res, rej) => {
    const onAbort = () => rej(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(res, rej).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function capEvidence(ev) {
  if (ev === undefined || ev === null) return undefined;
  const text = JSON.stringify(ev);
  if (text.length <= MAX_EVIDENCE) return ev;
  return { truncated: true, preview: text.slice(0, 2000) };
}

// Keeps the whole io object under 8 KB: drops rows first, then falls back to a preview.
export function capIo(io) {
  if (io === undefined || io === null || typeof io !== 'object') return undefined;
  const size = (o) => JSON.stringify(o).length;
  if (size(io) <= MAX_IO) return io;
  const resp = io.response;
  if (resp && Array.isArray(resp.rows)) {
    let rows = resp.rows;
    const total = resp.rowCount ?? rows.length;
    while (rows.length > 0) {
      rows = rows.slice(0, Math.floor(rows.length / 2));
      const out = { ...io, response: { ...resp, rows, rowCount: total, truncated: true } };
      if (size(out) <= MAX_IO) return out;
    }
  }
  const out = { ...io, response: { truncated: true, preview: resp === undefined ? undefined : JSON.stringify(resp).slice(0, 2000) } };
  return size(out) <= MAX_IO ? out : { kind: io.kind, response: { truncated: true } };
}

/**
 * Runs one scenario. `emit(event)` receives every event synchronously in order.
 * Returns { verdict, counts, ms }.
 */
export async function runScenario(scenario, { actions, config = {}, emit, signal, runId = makeRunId() }) {
  let seq = 0;
  const send = (e) => emit({ runId, seq: seq++, ts: new Date().toISOString(), ...e });
  const t0 = Date.now();
  const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  const vars = { lab: config.lab, repo: config.repo };

  send({
    type: 'run.start',
    scenario: {
      id: scenario.id, title: scenario.title, tracker_row: scenario.tracker_row ?? null,
      tags: scenario.tags ?? [],
      summary: scenario.summary, flow: resolveLenient(scenario.flow, vars),
      steps: scenario.steps.map(({ id, phase, title, explain, always, compareKey }) => ({
        id, phase, title, explain, always: always === true, ...(compareKey ? { compareKey } : {}),
      })),
    },
  });

  let blocked = false;
  for (const step of scenario.steps) {
    if (blocked && step.always !== true) {
      counts.skipped++;
      send({ type: 'step.end', stepId: step.id, phase: step.phase, state: 'skipped', ms: 0 });
      continue;
    }
    send({ type: 'step.start', stepId: step.id, phase: step.phase, title: step.title, explain: step.explain });
    const s0 = Date.now();
    let state = 'pass';
    let evidence;
    let error;
    let io;
    let open = true;
    // Long jobs emit ~100k lines: stream the head, keep a rolling tail, flush it when the step ends.
    // Info and detail lines are counted separately so detail noise never displaces info lines.
    const lanes = { info: { n: 0, tail: [] }, detail: { n: 0, tail: [] } };
    const sendLog = (line, level) => send({ type: 'step.log', stepId: step.id, line, level });
    const stepSignal = blocked && signal?.aborted ? AbortSignal.timeout(ALWAYS_TIMEOUT_MS) : signal;
    const ctx = {
      log(line) {
        if (!open) return;
        for (const l of String(line).split(/\r?\n/)) {
          if (l === '') continue;
          const level = l.includes('[SUBSTEP]') ? 'detail' : 'info';
          const lane = lanes[level];
          const cap = CAPS[level];
          if (lane.n++ < cap.head) { sendLog(l, level); continue; }
          lane.tail.push(l);
          if (lane.tail.length > cap.tail) lane.tail.shift();
        }
      },
      vars, config, signal: stepSignal,
    };
    try {
      const fn = actions[step.action];
      if (typeof fn !== 'function') throw new Error(`Unknown action "${step.action}".`);
      const args = resolve(step.args ?? {}, vars);
      const res = await raceAbort(Promise.resolve().then(() => fn(args, ctx)), stepSignal);
      if (step.save && res && 'value' in res) vars[step.save] = res.value;
      evidence = capEvidence(res?.evidence);
      io = capIo(res?.io);
      if (res?.ok === false) state = 'fail';
    } catch (e) {
      state = 'blocked';
      error = e?.message || String(e);
    }
    open = false;
    for (const level of ['info', 'detail']) {
      const { n, tail } = lanes[level];
      if (!tail.length) continue;
      const omitted = n - CAPS[level].head - tail.length;
      if (omitted > 0) sendLog(`... ${omitted.toLocaleString('en-US')} lines omitted ...`, level);
      tail.forEach((l) => sendLog(l, level));
    }
    if (io !== undefined) send({ type: 'step.io', stepId: step.id, io });
    counts[state]++;
    if (state === 'blocked') blocked = true;
    const end = { type: 'step.end', stepId: step.id, phase: step.phase, state };
    if (evidence !== undefined) end.evidence = evidence;
    if (error !== undefined) end.error = error;
    send({ ...end, ms: Date.now() - s0 });
  }

  const verdict = counts.blocked ? 'Blocked' : counts.fail ? 'Fail' : 'Pass';
  const ms = Date.now() - t0;
  send({ type: 'run.end', verdict, counts, ms });
  return { verdict, counts, ms };
}
