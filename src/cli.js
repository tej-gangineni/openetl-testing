import config from './config.js';
import actions from './actions/index.js';
import { loadScenarios, filterScenarios } from './scenarios.js';
import { createStore } from './store.js';
import { createScheduler } from './scheduler.js';

const [cmd, arg] = process.argv.slice(2);
const { scenarios, errors } = loadScenarios();
errors.forEach((e) => console.error(`skipped ${e.file}: ${e.error}`));

function ioLines(io) {
  const out = [];
  const rq = io.request ?? {};
  const rqText = rq.text ?? rq.url ?? rq.path ?? rq.container ?? (rq.op ? `${rq.left} ${rq.op} ${rq.right}` : JSON.stringify(rq));
  out.push(`request  [${io.kind}] ${[rq.method, rq.target, rqText].filter(Boolean).join(' ')}`.slice(0, 300));
  const r = io.response;
  if (r) {
    let sum;
    if (Array.isArray(r.rows)) sum = `${r.rowCount ?? r.rows.length} row(s)${r.truncated ? ' (truncated)' : ''} ${JSON.stringify(r.rows.slice(0, 2))}`;
    else if (r.status !== undefined) sum = `HTTP ${r.status} ${String(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 120)}`;
    else if (r.exitCode !== undefined) sum = `exit ${r.exitCode} ${JSON.stringify(r.summary ?? {})}`;
    else sum = JSON.stringify(r);
    out.push(`response ${sum}`.slice(0, 300));
  }
  return out;
}

function line(ev) {
  const t = ev.ts.slice(11, 19);
  switch (ev.type) {
    case 'run.start': return `${t} RUN   ${ev.scenario.id}  ${ev.scenario.title} (${ev.scenario.steps.length} steps)`;
    case 'step.start': return `${t} START ${ev.phase.padEnd(8)} ${ev.stepId}  ${ev.title}${ev.explain ? `\n${t}       why: ${ev.explain}` : ''}`;
    case 'step.log': return ev.level === 'detail' ? null : `${t}       | ${ev.line}`;
    case 'step.io': return ioLines(ev.io).map((l) => `${t}       ${l}`).join('\n');
    case 'step.end': {
      let s = `${t} ${ev.state.toUpperCase().padEnd(7)}${ev.stepId} (${ev.ms}ms)`;
      if (ev.evidence) s += `  ${JSON.stringify(ev.evidence).slice(0, 200)}`;
      if (ev.error) s += `  ${ev.error}`;
      return s;
    }
    case 'run.end': {
      const c = ev.counts;
      return `${t} VERDICT ${ev.verdict}  pass=${c.pass} fail=${c.fail} blocked=${c.blocked} skipped=${c.skipped} (${ev.ms}ms)`;
    }
    default: return `${t} ${ev.type}`;
  }
}

if (cmd === 'list') {
  for (const s of filterScenarios(scenarios)) {
    console.log(`${s.id.padEnd(40)} ${String(s.steps.length).padStart(2)} steps  [${s.tags.join(', ')}]  ${s.title}`);
  }
} else if (cmd === 'run' && arg) {
  const scenario = scenarios.find((s) => s.id === arg);
  if (!scenario) {
    console.error(`No scenario with id "${arg}". Try: node src/cli.js list`);
    process.exit(2);
  }
  const store = createStore();
  store.closeInterrupted();
  const scheduler = createScheduler({ store, actions, config });
  const runId = scheduler.enqueue(scenario);
  let verdict = 'Blocked';
  const interrupt = () => {
    try { store.closeInterrupted(runId); store.close(); } catch { /* already closed */ }
    process.exit(2);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.stdout.on('error', interrupt);
  // enqueue already started the run, so replay what exists, then follow live.
  const seen = new Set();
  const show = (ev) => {
    if (seen.has(ev.seq)) return;
    seen.add(ev.seq);
    const text = line(ev);
    if (text !== null) console.log(text);
    if (ev.type === 'run.end') verdict = ev.verdict;
  };
  scheduler.subscribe(runId, show);
  store.getEvents(runId).forEach(show);
  await scheduler.idle();
  store.close();
  process.exit({ Pass: 0, Fail: 1, Blocked: 2 }[verdict]);
} else {
  console.error('Usage: node src/cli.js list | run <scenarioId>');
  process.exit(2);
}
