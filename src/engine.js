import crypto from 'node:crypto';
import { resolve } from './template.js';

const MAX_EVIDENCE = 8 * 1024;
const LOG_HEAD = 200;
const LOG_TAIL = 200;

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
      steps: scenario.steps.map(({ id, phase, title }) => ({ id, phase, title })),
    },
  });

  let blocked = false;
  for (const step of scenario.steps) {
    if (blocked) {
      counts.skipped++;
      send({ type: 'step.end', stepId: step.id, phase: step.phase, state: 'skipped', ms: 0 });
      continue;
    }
    send({ type: 'step.start', stepId: step.id, phase: step.phase, title: step.title });
    const s0 = Date.now();
    let state = 'pass';
    let evidence;
    let error;
    let open = true;
    // Long jobs emit ~100k lines: stream the head, keep a rolling tail, flush it when the step ends.
    let logged = 0;
    const tail = [];
    const sendLog = (line) => send({ type: 'step.log', stepId: step.id, line });
    const ctx = {
      log(line) {
        if (!open) return;
        for (const l of String(line).split(/\r?\n/)) {
          if (l === '') continue;
          if (logged++ < LOG_HEAD) { sendLog(l); continue; }
          tail.push(l);
          if (tail.length > LOG_TAIL) tail.shift();
        }
      },
      vars, config, signal,
    };
    try {
      const fn = actions[step.action];
      if (typeof fn !== 'function') throw new Error(`Unknown action "${step.action}".`);
      const args = resolve(step.args ?? {}, vars);
      const res = await raceAbort(Promise.resolve().then(() => fn(args, ctx)), signal);
      if (step.save && res && 'value' in res) vars[step.save] = res.value;
      evidence = capEvidence(res?.evidence);
      if (res?.ok === false) state = 'fail';
    } catch (e) {
      state = 'blocked';
      error = e?.message || String(e);
    }
    open = false;
    if (tail.length) {
      const omitted = logged - LOG_HEAD - tail.length;
      if (omitted > 0) sendLog(`... ${omitted.toLocaleString('en-US')} lines omitted ...`);
      tail.forEach(sendLog);
    }
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
