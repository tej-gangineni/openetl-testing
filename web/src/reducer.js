// Pure run-state reducer. Feed it contract events (docs/CONTRACT.md, v2) one at
// a time; it has no DOM or React dependency so node can test it directly.
export const PHASES = ['prepare', 'trigger', 'observe', 'verify'];
export const PHASE_NAME = { prepare: 'Prepare', trigger: 'Run', observe: 'Check the run', verify: 'Check the database' };
export const PHASE_HINT = {
  prepare: 'Set up the starting state and take a first look.',
  trigger: 'Start OpenETL and wait for it to finish.',
  observe: 'Did the run itself report success?',
  verify: 'Look in the database and compare it with the source.',
};

export const initialRun = {
  runId: null, scenario: null, order: [], steps: {},
  verdict: null, counts: null, ms: null, note: null, seq: -1, rxStart: null, rxEnd: null,
};

const blankStep = (s) => ({
  id: s.id, phase: s.phase, title: s.title || s.id, explain: s.explain || '', always: !!s.always,
  compareKey: s.compareKey || null,
  state: 'waiting', logs: [], io: null, evidence: undefined, error: undefined, ms: undefined,
});

// Fold a step update in, creating the step if an event arrives before run.start.
function upd(state, e, patch) {
  const cur = state.steps[e.stepId] || blankStep({ id: e.stepId, phase: e.phase, title: e.title, explain: e.explain, compareKey: e.compareKey });
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
    case 'step.start':
      return upd(base, e, (c) => ({ state: 'running', phase: e.phase, title: e.title || c.title, explain: e.explain || c.explain, compareKey: e.compareKey || c.compareKey }));
    case 'step.log': return upd(base, e, (c) => ({ logs: [...c.logs, { line: e.line, level: e.level === 'detail' ? 'detail' : 'info' }] }));
    case 'step.io': return upd(base, e, () => ({ io: e.io }));
    case 'step.end':
      return upd(base, e, (c) => ({ state: e.state, evidence: e.evidence, error: e.error, ms: e.ms, compareKey: e.compareKey || c.compareKey }));
    case 'run.end': return { ...base, verdict: e.verdict, counts: e.counts, ms: e.ms, note: e.note || null, rxEnd: rx };
    default: return base;
  }
}

// State of a whole phase: waiting | running | pass | fail | blocked | skipped | empty.
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

// ---- derived views used by the screen -------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v
  : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);

// When a step has no `step.io` (older runs) build a displayable one from evidence.
export function effectiveIo(step) {
  if (step.io) return step.io;
  const ev = step.evidence;
  if (!ev || typeof ev !== 'object') return null;
  if ('left' in ev && 'op' in ev && 'right' in ev) return { kind: 'compare', request: { left: ev.left, op: ev.op, right: ev.right } };
  if (typeof ev.sql === 'string' && Array.isArray(ev.rows)) {
    const first = ev.rows[0];
    if (first && !Array.isArray(first) && typeof first === 'object') {
      const columns = Object.keys(first);
      return { kind: 'sql', request: { text: ev.sql }, response: { columns, rows: ev.rows.map((r) => columns.map((c) => r[c])), rowCount: ev.rows.length } };
    }
    return { kind: 'sql', request: { text: ev.sql }, response: { columns: ['value'], rows: ev.rows.map((r) => (Array.isArray(r) ? r : [r])), rowCount: ev.rows.length } };
  }
  return { kind: 'evidence', evidence: ev };
}

// Live numbers for the flow diagram, taken only from what the events contain.
export function counters(run) {
  const out = { files: null, records: null, rows: null };
  for (const id of run.order) {
    const s = run.steps[id];
    const io = s.io;
    if (!io || s.state === 'waiting') continue;
    const resp = io.response || {};
    if (io.kind === 'fs') {
      const n = num(resp.count ?? resp.matched ?? resp.fileCount) ?? num(s.evidence && s.evidence.count) ?? (Array.isArray(resp.files) ? resp.files.length : null);
      if (n != null) out.files = n;
    } else if (io.kind === 'command' && resp.summary && typeof resp.summary === 'object') {
      const m = resp.summary;
      const n = num(m.records_written ?? m.records ?? m.rows_written ?? m.written ?? m.records_loaded);
      if (n != null) out.records = n;
      const f = num(m.files_found ?? m.files);
      if (f != null && out.files == null) out.files = f;
    } else if (io.kind === 'sql' && Array.isArray(resp.rows) && resp.rows.length === 1) {
      const text = String((io.request && io.request.text) || '');
      const n = /count\s*\(/i.test(text) ? num(resp.rows[0][0]) : null;
      if (n != null) out.rows = n;
    }
  }
  return out;
}

// Which flow box the current work touches: source | engine | target | null.
export function touching(run) {
  const id = [...run.order].reverse().find((i) => run.steps[i].state === 'running');
  if (!id) return null;
  const s = run.steps[id];
  const k = s.io && s.io.kind;
  if (k === 'fs') return 'source';
  if (k === 'command' || s.phase === 'trigger') return 'engine';
  if (k === 'sql' || k === 'http' || k === 'docker') return 'target';
  if (k === 'compare') return 'engine';
  if (s.phase === 'prepare') return /file|source|download|folder|directory/i.test(`${s.title} ${s.explain}`) ? 'source' : 'target';
  if (s.phase === 'observe' && /finish|status|exit|clean/i.test(s.title)) return 'engine';
  return 'target';
}

// Steps sharing a compareKey are one Before | After pair: first is Before, last is After.
export function comparePairs(run) {
  const groups = new Map();
  for (const id of run.order) {
    const k = run.steps[id].compareKey;
    if (k) groups.set(k, [...(groups.get(k) || []), id]);
  }
  const after = new Map();   // afterId -> beforeId
  const before = new Set();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    after.set(ids[ids.length - 1], ids[0]);
    before.add(ids[0]);
  }
  return { after, before };
}

export const OP_WORDS = { eq: 'equals', ne: 'is not', gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most', contains: 'contains' };

// One plain sentence that says why a comparison failed.
export function describeDiff(left, op, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    const n = (v) => (Array.isArray(v) ? v.length : null);
    const words = (v) => (n(v) === 0 ? 'an empty list' : `${n(v)} ${n(v) === 1 ? 'item' : 'items'}`);
    if (op === 'eq' && n(left) != null && n(right) != null) return `Expected ${words(right)}; got ${words(left)}.`;
  }
  const a = num(left), b = num(right);
  if (op === 'eq') {
    if (a != null && b != null && typeof left === 'number' && typeof right === 'number') {
      const d = Math.abs(a - b);
      return `${left} is ${d} ${a < b ? 'less' : 'more'} than the expected ${right}.`;
    }
    return 'The two values are not the same.';
  }
  if (op === 'ne') return 'The two values are equal, but they should differ.';
  return `Expected the left value ${OP_WORDS[op] || op} the right value, but it does not.`;
}

// Flow details may arrive with an unresolved ${var}; show only what follows the last one.
export function resolveDetail(d) {
  if (typeof d !== 'string' || !d.includes('${')) return d;
  return d.slice(d.lastIndexOf('}') + 1);
}
