import { runScenario, makeRunId } from './engine.js';

export const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * FIFO queue with resource locks. A queued scenario can start when a slot is free and none of
 * its resources is held by a running scenario or reserved by an earlier queued one.
 */
export function createScheduler({
  store, actions, config,
  concurrency = Number(process.env.TEST_CONCURRENCY) || 1,
  timeoutMs = TIMEOUT_MS,
}) {
  const queue = [];
  const held = new Set();
  const listeners = new Map();
  const active = new Set();
  let running = 0;
  let idleWaiters = [];

  function emit(ev) {
    store.addEvent(ev);
    for (const fn of [...(listeners.get(ev.runId) ?? [])]) {
      try { fn(ev); } catch { /* a bad subscriber must not break the run */ }
    }
  }

  async function start(job) {
    const { scenario, runId } = job;
    running++;
    for (const r of scenario.resources ?? []) held.add(r);
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(new Error(`Scenario timed out after ${Math.round(timeoutMs / 1000)} seconds.`)),
      timeoutMs,
    );
    let ended = false;
    try {
      await runScenario(scenario, {
        actions, config, runId, signal: ctl.signal,
        emit: (ev) => { if (ev.type === 'run.end') ended = true; emit(ev); },
      });
    } catch (e) {
      if (!ended) {
        emit({
          runId, seq: store.getEvents(runId).length, ts: new Date().toISOString(), type: 'run.end',
          verdict: 'Blocked', counts: { pass: 0, fail: 0, blocked: 1, skipped: 0 }, ms: 0, error: e.message,
        });
      }
    } finally {
      clearTimeout(timer);
      for (const r of scenario.resources ?? []) held.delete(r);
      running--;
      active.delete(runId);
      listeners.delete(runId);
      pump();
    }
  }

  function pump() {
    const reserved = new Set(held);
    for (let i = 0; i < queue.length && running < concurrency;) {
      const res = queue[i].scenario.resources ?? [];
      if (res.some((r) => reserved.has(r))) {
        res.forEach((r) => reserved.add(r));
        i++;
        continue;
      }
      const [job] = queue.splice(i, 1);
      start(job);
      res.forEach((r) => reserved.add(r));
    }
    if (!running && !queue.length) {
      idleWaiters.forEach((f) => f());
      idleWaiters = [];
    }
  }

  return {
    enqueue(scenario) {
      const runId = makeRunId();
      store.createRun(runId, scenario.id);
      active.add(runId);
      queue.push({ scenario, runId });
      pump();
      return runId;
    },
    subscribe(runId, fn) {
      if (!listeners.has(runId)) listeners.set(runId, new Set());
      listeners.get(runId).add(fn);
      return () => listeners.get(runId)?.delete(fn);
    },
    isActive: (runId) => active.has(runId),
    idle: () => (!running && !queue.length ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
  };
}
