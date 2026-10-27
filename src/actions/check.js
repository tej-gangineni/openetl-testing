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
  return { ok, value: ok, evidence: { left, op, right } };
}
