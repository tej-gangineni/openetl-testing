import { cut } from './io.js';

const OPS = {
  eq: (a, b) => same(a, b),
  ne: (a, b) => !same(a, b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => (Array.isArray(a) ? a.includes(b) : String(a).includes(String(b))),
};

// Numeric strings equal numbers ("12" eq 12); everything else compares as JSON.
function same(a, b) {
  if (a === b) return true;
  const num = (x) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) && !isNaN(Number(x));
  if (num(a) && num(b)) return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function compare({ left, op, right }, ctx) {
  const fn = OPS[op];
  if (!fn) throw new Error(`Unknown op: ${op}`);
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && (isNaN(Number(left)) || isNaN(Number(right)))) {
    throw new Error(`Op ${op} needs numbers, got ${JSON.stringify(left)} and ${JSON.stringify(right)}`);
  }
  const ok = fn(left, right);
  ctx?.log?.(`${JSON.stringify(left)} ${op} ${JSON.stringify(right)} -> ${ok ? 'true' : 'false'}`);
  const show = (v) => (typeof v === 'string' ? cut(v, 1200) : JSON.stringify(v)?.length > 1200 ? cut(v, 1200) : v);
  return {
    ok, value: ok, evidence: { left, op, right },
    io: { kind: 'compare', request: { left: show(left), op, right: show(right) }, response: { ok, result: ok ? 'true' : 'false' } },
  };
}

// Which expected items are absent from the actual list? ok when none. value = the missing items.
export async function missing({ expected, actual }, ctx) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) throw new Error('expected and actual must be lists');
  const have = new Set(actual);
  const gone = expected.filter((x) => !have.has(x));
  const ok = gone.length === 0;
  ctx?.log?.(`${expected.length} expected, ${actual.length} found, ${gone.length} missing${gone.length ? ': ' + gone.join(', ') : ''}`);
  return {
    ok, value: gone, evidence: { expected: expected.length, found: actual.length, missing: gone },
    io: { kind: 'compare', request: { left: `${expected.length} expected items`, op: 'all present in', right: `${actual.length} found items` }, response: { ok, missing: gone.slice(0, 50) } },
  };
}
