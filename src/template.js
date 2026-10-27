const WHOLE = /^\$\{([^}]+)\}$/;
const EMBEDDED = /\$\{([^}]+)\}/g;

function lookup(vars, name) {
  let cur = vars;
  for (const part of name.trim().split('.')) {
    if (cur === null || cur === undefined || !(part in Object(cur))) {
      throw new Error(`Template variable "${name.trim()}" is not defined.`);
    }
    cur = cur[part];
  }
  return cur;
}

// A string that is exactly one ${...} keeps the value's type; otherwise values are stringified.
export function resolve(value, vars) {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(vars, whole[1]);
    return value.replace(EMBEDDED, (_, name) => {
      const v = lookup(vars, name);
      return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, vars)]));
  }
  return value;
}
