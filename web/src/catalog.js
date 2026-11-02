import rows from './catalog.json';

// The tracker's 207 test cases, grouped into ten categories. Each category groups
// one or more matrix components; sub-components come from the tracker.
export const CATS = [
  { name: 'Run model', blurb: 'How OpenETL runs: jobs, streams, restarts', comps: ['Run model'] },
  { name: 'Deployment', blurb: 'Hosting, workers, control plane, tenancy', comps: ['Deployment & Architecture'] },
  { name: 'Batch sources', blurb: 'Files, SaaS, web and connector pulls', comps: ['Sources — shipped', 'Sources — source parity'] },
  { name: 'Streaming sources', blurb: 'Live listeners, brokers, vendor protocols', comps: ['Sources — telemetry', 'Sources — universal ingestion', 'Sources — ingestion frameworks'] },
  { name: 'Destinations', blurb: 'Where data lands: stores, sockets, SIEMs', comps: ['Destinations — shipped', 'Destinations — telemetry'] },
  { name: 'Processing', blurb: 'Parse, transform, enrich, reduce', comps: ['Processing'] },
  { name: 'Routing', blurb: 'Send each event to the right place', comps: ['Routing'] },
  { name: 'Reliability', blurb: 'Queues, retries, replay, delivery', comps: ['Reliability'] },
  { name: 'Documents & AI', blurb: 'Parsing, chunking, entities, embeddings', comps: ['Documents & intelligence'] },
  { name: 'Ops & governance', blurb: 'API, console, access, quality, scheduling', comps: ['Ops, Governance & DX'] },
];

CATS.forEach((c, ci) => {
  c.i = ci;
  c.rows = rows.filter((r) => c.comps.includes(r.comp));
  c.subs = [];
  for (const r of c.rows) {
    let s = c.subs.find((x) => x.name === r.sub);
    if (!s) { s = { name: r.sub, rows: [] }; c.subs.push(s); }
    s.rows.push(r);
  }
});

export const ALL_ROWS = rows;

// tracker_row on a scenario is "r047" or "r140, r142".
export function scenarioRows(s) { return String(s.tracker_row || '').split(/[,\s]+/).filter(Boolean); }

// rowId -> scenarios that cover it
export function coverage(scenarios) {
  const m = new Map();
  for (const s of scenarios || []) for (const id of scenarioRows(s)) m.set(id, [...(m.get(id) || []), s]);
  return m;
}

const WORST = ['Fail', 'Blocked', 'Pass'];
// last verdict for a row from the scenarios that cover it (worst wins); null when never run
export function rowVerdict(list) {
  const v = (list || []).map((s) => s.lastRun && s.lastRun.verdict).filter(Boolean);
  return WORST.find((w) => v.includes(w)) || null;
}

// Summary of a set of rows: how many have a scenario, and how those last ran.
export function summarise(rs, cov) {
  const out = { total: rs.length, automated: 0, Pass: 0, Fail: 0, Blocked: 0, notRun: 0 };
  for (const r of rs) {
    const list = cov.get(r.id);
    if (!list) continue;
    out.automated++;
    const v = rowVerdict(list);
    if (v) out[v]++; else out.notRun++;
  }
  return out;
}
