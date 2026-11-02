import { cut } from './io.js';

const OPS = {
  eq: (a, b) => same(a, b),
  ne: (a, b) => !same(a, b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => (Array.isArray(a) ? a.includes(b) : text(a).includes(String(b))),
  not_contains: (a, b) => (Array.isArray(a) ? !a.includes(b) : !text(a).includes(String(b))),
};

// Objects are searched as JSON, so "contains" on a response object looks inside it.
function text(a) {
  return a !== null && typeof a === 'object' ? JSON.stringify(a) : String(a);
}

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

// after - before compared with expected (default op eq). Used for "the target count rose by exactly N".
export async function delta({ before, after, expected, op = 'eq' }, ctx) {
  const fn = OPS[op];
  if (!fn) throw new Error(`Unknown op: ${op}`);
  if ([before, after, expected].some((x) => x === null || x === undefined || x === '' || isNaN(Number(x)))) {
    throw new Error(`check.delta needs numbers, got before=${JSON.stringify(before)} after=${JSON.stringify(after)} expected=${JSON.stringify(expected)}`);
  }
  const d = Number(after) - Number(before);
  const ok = fn(d, Number(expected));
  ctx?.log?.(`${after} - ${before} = ${d} ${op} ${expected} -> ${ok}`);
  return {
    ok, value: d, evidence: { before, after, delta: d, op, expected },
    io: { kind: 'compare', request: { left: `${after} - ${before} = ${d}`, op, right: expected }, response: { ok, result: ok ? 'true' : 'false' } },
  };
}

// Which of `keys` (dotted paths allowed) are absent from `object`? ok when none.
export async function hasKeys({ object, keys }, ctx) {
  if (!object || typeof object !== 'object') throw new Error(`hasKeys needs an object, got ${JSON.stringify(object)?.slice(0, 100)}`);
  if (!Array.isArray(keys)) throw new Error('keys must be a list');
  const get = (o, k) => k.split('.').reduce((a, p) => (a !== null && a !== undefined && typeof a === 'object' && p in a ? a[p] : undefined), o);
  const gone = keys.filter((k) => get(object, k) === undefined);
  const ok = gone.length === 0;
  ctx?.log?.(`${keys.length} keys expected, ${gone.length} missing${gone.length ? ': ' + gone.join(', ') : ''}`);
  return {
    ok, value: gone, evidence: { expected: keys, missing: gone, present: Object.keys(object).slice(0, 40) },
    io: { kind: 'compare', request: { left: `keys of object (${Object.keys(object).slice(0, 30).join(', ')})`, op: 'has all of', right: keys.join(', ') }, response: { ok, missing: gone } },
  };
}
