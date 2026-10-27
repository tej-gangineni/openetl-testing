// Pure run-state reducer. Feed it contract events (docs/CONTRACT.md) one at a
// time; it has no DOM or React dependency so node can test it directly.
export const PHASES = ['prepare', 'trigger', 'observe', 'verify'];

export const initialRun = {
  runId: null, scenario: null, order: [], steps: {},
  verdict: null, counts: null, ms: null, seq: -1, rxStart: null, rxEnd: null,
};

const blankStep = (s) => ({
  id: s.id, phase: s.phase, title: s.title || s.id,
  state: 'waiting', logs: [], evidence: undefined, error: undefined, ms: undefined,
});

// Fold a step update in, creating the step if an event arrives before run.start.
function upd(state, e, patch) {
  const cur = state.steps[e.stepId] || blankStep({ id: e.stepId, phase: e.phase, title: e.title });
  const order = state.steps[e.stepId] ? state.order : [...state.order, e.stepId];
  return { ...state, order, steps: { ...state.steps, [e.stepId]: { ...cur, ...patch(cur) } } };
}

export function runReducer(state, e) {
  if (e.type === 'reset') return initialRun;
  // SSE can redeliver after a reconnect; seq is monotonic per run.
  if (typeof e.seq === 'number' && e.seq <= state.seq) return state;
  const base = typeof e.seq === 'number' ? { ...state, seq: e.seq } : state;
  const rx = e._rx ?? Date.now();
  switch (e.type) {
    case 'run.start': {
      const steps = {};
      for (const s of e.scenario.steps) steps[s.id] = blankStep(s);
      return { ...initialRun, seq: base.seq, runId: e.runId, scenario: e.scenario, order: e.scenario.steps.map((s) => s.id), steps, rxStart: rx };
    }
    case 'step.start': return upd(base, e, () => ({ state: 'running', phase: e.phase, title: e.title || undefined }));
    case 'step.log': return upd(base, e, (c) => ({ logs: [...c.logs, e.line] }));
    case 'step.end':
      return upd(base, e, () => ({ state: e.state, evidence: e.evidence, error: e.error, ms: e.ms }));
    case 'run.end': return { ...base, verdict: e.verdict, counts: e.counts, ms: e.ms, rxEnd: rx };
    default: return base;
  }
}

// State of a whole phase for the header: waiting | running | pass | fail | blocked.
export function phaseState(run, phase) {
  const ss = run.order.map((id) => run.steps[id]).filter((s) => s.phase === phase);
  if (!ss.length) return 'empty';
  if (ss.some((s) => s.state === 'blocked')) return 'blocked';
  if (ss.some((s) => s.state === 'fail')) return 'fail';
  if (ss.some((s) => s.state === 'running')) return 'running';
  if (ss.every((s) => s.state === 'skipped')) return 'skipped';
  if (ss.every((s) => s.state === 'pass' || s.state === 'skipped')) return 'pass';
  return ss.some((s) => s.state !== 'waiting') ? 'running' : 'waiting';
}
