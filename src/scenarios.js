import fs from 'node:fs';
import path from 'node:path';
import { root } from './config.js';

export const defaultDir = path.join(root, 'scenarios');
const PHASES = ['prepare', 'trigger', 'observe', 'verify'];

export function validate(s) {
  const bad = (msg) => { throw new Error(msg); };
  if (!s || typeof s !== 'object') bad('scenario must be an object');
  if (typeof s.id !== 'string' || !s.id) bad('missing id');
  if (typeof s.title !== 'string') bad('missing title');
  if (!Array.isArray(s.steps) || s.steps.length === 0) bad('steps must be a non-empty array');
  const seen = new Set();
  for (const st of s.steps) {
    if (!st || typeof st.id !== 'string' || !st.id) bad('every step needs an id');
    if (seen.has(st.id)) bad(`duplicate step id "${st.id}"`);
    seen.add(st.id);
    if (!PHASES.includes(st.phase)) bad(`step "${st.id}" has invalid phase "${st.phase}"`);
    if (typeof st.action !== 'string') bad(`step "${st.id}" is missing an action`);
    if (typeof st.title !== 'string') bad(`step "${st.id}" is missing a title`);
  }
  for (const k of ['tags', 'resources']) {
    if (s[k] !== undefined && !Array.isArray(s[k])) bad(`${k} must be an array`);
  }
  return { ...s, tags: s.tags ?? [], resources: s.resources ?? [] };
}

// Invalid files are reported in `errors` rather than breaking the whole list.
export function loadScenarios(dir = defaultDir) {
  const scenarios = [];
  const errors = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { /* no dir yet */ }
  for (const f of files) {
    try {
      scenarios.push(validate(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
    } catch (e) {
      errors.push({ file: f, error: e.message });
    }
  }
  return { scenarios, errors };
}

export function filterScenarios(scenarios, { tag, q } = {}) {
  const needle = q?.toLowerCase();
  return scenarios.filter((s) => {
    if (tag && !s.tags.includes(tag)) return false;
    if (needle) {
      const hay = [s.id, s.title, s.tracker_row ?? '', ...s.tags].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
