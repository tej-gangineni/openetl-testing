import React, { useState } from 'react';
import { StateIcon, STATE_LABEL, fmtMs, fmtN } from './ui.jsx';
import { PHASES, PHASE_NAME, PHASE_HINT, phaseState, effectiveIo, comparePairs, OP_WORDS, describeDiff } from '../reducer.js';

const text = (v) => (v == null ? 'null' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

// ---- small real table -------------------------------------------------------
function Cell({ v }) {
  return v == null ? <td className="nul">null</td> : <td className={typeof v === 'number' ? 'numc' : ''} title={text(v)}>{text(v)}</td>;
}

function DataTable({ columns = [], rows = [], rowCount, truncated, mark }) {
  return (
    <div className="tablewrap">
      <table className="data">
        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={mark && mark(r, i)}>
              {(Array.isArray(r) ? r : columns.map((c) => r[c])).map((v, j) => <Cell key={j} v={v} />)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tcap">{rowCount != null ? `${fmtN(rowCount)} ${rowCount === 1 ? 'row' : 'rows'}` : `${rows.length} rows`}{truncated ? `, first ${rows.length} shown` : ''}</p>
    </div>
  );
}

function KV({ obj }) {
  return (
    <dl className="kv">
      {Object.entries(obj).map(([k, v]) => <React.Fragment key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{typeof v === 'number' ? fmtN(v) : text(v)}</dd></React.Fragment>)}
    </dl>
  );
}

// ---- request / response ----------------------------------------------------
const REQ_LABEL = { command: 'OpenETL was told to run', sql: 'Query sent to the database', http: 'HTTP call sent', fs: 'Looked in the source folder', docker: 'Asked Docker to' };
const RES_LABEL = { command: 'What OpenETL reported', sql: 'What the database sent back', http: 'What the API sent back', fs: 'Files found', docker: 'What Docker said' };

function Request({ io }) {
  const r = io.request || {};
  switch (io.kind) {
    case 'command': return <pre className="mono">{[`$ ${r.text}`, r.cwd && `in ${r.cwd}`].filter(Boolean).join('\n')}</pre>;
    case 'sql': return <pre className="mono">{[r.target && `database  ${r.target}`, r.text].filter(Boolean).join('\n')}</pre>;
    case 'http': {
      const head = Object.entries(r.headers || {}).map(([k, v]) => `${k}: ${v}`);
      return <pre className="mono">{[`${r.method || 'GET'} ${r.url}`, ...head, r.body != null && '', r.body != null && pretty(r.body)].filter((x) => x !== false && x != null).join('\n')}</pre>;
    }
    case 'fs': return <pre className="mono">{[`folder  ${r.path}`, r.glob && `match   ${r.glob}`].filter(Boolean).join('\n')}</pre>;
    case 'docker': return <pre className="mono">{[`container  ${r.container}`, `action     ${r.op}`].join('\n')}</pre>;
    default: return null;
  }
}

function Response({ io }) {
  const r = io.response;
  if (!r) return null;
  if (io.kind === 'command') {
    return <>
      <p className="exit"><span className={r.exitCode === 0 ? 'ok' : 'bad'}>{r.exitCode === 0 ? 'Finished' : 'Exited with an error'}</span> exit code {r.exitCode}</p>
      {r.summary && typeof r.summary === 'object' ? <KV obj={r.summary} /> : r.summary != null && <pre className="mono">{text(r.summary)}</pre>}
    </>;
  }
  if (io.kind === 'http') {
    return <>
      <p className="exit"><span className={r.status >= 200 && r.status < 300 ? 'ok' : 'bad'}>HTTP {r.status}</span></p>
      {r.body != null && <pre className="mono json">{pretty(r.body)}</pre>}
    </>;
  }
  if (io.kind === 'docker') return <KV obj={{ ok: r.ok, state: r.state }} />;
  if (Array.isArray(r.columns)) return <DataTable {...r} />;
  return <pre className="mono">{pretty(r)}</pre>;
}

// ---- comparison -------------------------------------------------------------
// One value of a comparison: scalar, short list as bullets (collapsed after 5), or JSON.
function Val({ v }) {
  const [all, setAll] = useState(false);
  if (Array.isArray(v)) {
    if (!v.length) return <span className="emptyval">empty list</span>;
    const list = all ? v : v.slice(0, 5);
    return (
      <>
        <ul className="vlist2">{list.map((x, i) => <li key={i}>{text(x)}</li>)}</ul>
        {v.length > 5 && <button className="link" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${fmtN(v.length)}`}</button>}
      </>
    );
  }
  if (v && typeof v === 'object') return <pre>{pretty(v)}</pre>;
  return <pre>{text(v)}</pre>;
}

// Shown once per compare step. Left is what was found, right is what was expected.
function CompareView({ req, state }) {
  const done = state === 'pass' || state === 'fail';
  return (
    <div className={`cmp ${done ? state : ''}`}>
      <div className="side"><span className="cap">Left (found)</span><Val v={req.left} /></div>
      <div className="mid"><b>{req.op}</b><span>{OP_WORDS[req.op] || ''}</span></div>
      <div className="side"><span className="cap">Right (expected)</span><Val v={req.right} /></div>
      {state === 'fail' && <p className="why">{describeDiff(req.left, req.op, req.right)}</p>}
      {state === 'pass' && <p className="why okk">The check held.</p>}
    </div>
  );
}

// ---- before | after ---------------------------------------------------------
function BeforeAfter({ before, after, afterState }) {
  const b = before && before.response, a = after && after.response;
  if (!b && !a) return null;
  const cols = (a || b).columns || [];
  const single = (!b || b.rows.length <= 1) && (!a || a.rows.length <= 1);
  if (single) {
    const br = b && b.rows[0], ar = a && a.rows[0];
    return (
      <div className="tablewrap">
        <table className="data ba">
          <thead><tr><th /><th>Before</th><th>After</th></tr></thead>
          <tbody>
            {cols.map((c, i) => {
              const bv = br ? br[i] : undefined, av = ar ? ar[i] : undefined;
              const changed = br && ar && text(bv) !== text(av);
              return <tr key={c}><th scope="row">{c}</th><Cell v={br ? bv : '...'} /><td className={`${changed ? 'chg' : ''} ${typeof av === 'number' ? 'numc' : ''}`}>{ar ? text(av) : afterState === 'skipped' ? 'not reached' : '...'}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
    );
  }
  const key = (r) => text(r[0]);
  const bk = new Map((b ? b.rows : []).map((r) => [key(r), r]));
  const ak = new Map((a ? a.rows : []).map((r) => [key(r), r]));
  const mark = (other) => (r) => {
    const o = other.get(key(r));
    return !o ? 'newrow' : o.some((v, i) => text(v) !== text(r[i])) ? 'chgrow' : '';
  };
  return (
    <div className="ba2">
      <div><h5>Before</h5>{b ? <DataTable {...b} mark={mark(ak)} /> : <p className="muted small">Not captured yet.</p>}</div>
      <div><h5>After</h5>{a ? <DataTable {...a} mark={mark(bk)} /> : <p className="muted small">Not reached yet.</p>}</div>
    </div>
  );
}

// ---- logs -------------------------------------------------------------------
function LogBox({ logs, running }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(false);
  if (!logs.length) return null;
  const info = logs.filter((l) => l.level !== 'detail');
  const nDetail = logs.length - info.length;
  const small = info.length <= 6 && nDetail === 0;
  const shown = (small || open) ? (detail ? logs : info) : [];
  const tail = running && !shown.length ? logs.slice(-3) : [];
  return (
    <div className="logs">
      {!small && (
        <div className="logbar">
          <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {fmtN(info.length || nDetail)} log {(info.length || nDetail) === 1 ? 'line' : 'lines'}</button>
          {open && nDetail > 0 && info.length > 0 && <button className="link" aria-pressed={detail} onClick={() => setDetail(!detail)}>{detail ? 'Hide' : 'Show'} {fmtN(nDetail)} detail lines</button>}
        </div>
      )}
      {(shown.length > 0 || tail.length > 0) && (
        <ol className="logl">{(shown.length ? shown : tail).slice(-2000).map((l, i) => <li key={i} className={l.level === 'detail' ? 'det' : ''}>{l.line}</li>)}</ol>
      )}
    </div>
  );
}

// ---- one step ---------------------------------------------------------------
function StepCard({ step, run, pairBefore, isBefore }) {
  const io = effectiveIo(step);
  const beforeIo = pairBefore ? effectiveIo(run.steps[pairBefore]) : null;
  const failed = step.state === 'fail' || step.state === 'blocked';
  const cmp = io && io.kind === 'compare';
  const trigger = run.order.map((i) => run.steps[i]).find((s) => s.phase === 'trigger');
  const ownInfo = step.logs.filter((l) => l.level !== 'detail');
  // The log box already shows a short own log; only add a preview when it would be hidden or is borrowed.
  const failLogs = failed && (ownInfo.length > 6 || !step.logs.length)
    ? (step.logs.length ? ownInfo : trigger ? trigger.logs.filter((l) => l.level !== 'detail') : []).slice(0, 6) : [];
  const quiet = step.state === 'waiting' || step.state === 'skipped';
  return (
    <li id={`step-${step.id}`} className={`step s-${step.state} ${failed ? 'focus' : ''}`}>
      <span className="rail" aria-hidden="true"><span className="mk" key={step.state}><StateIcon state={step.state} /></span></span>
      <div className="card">
        <header>
          <h3>{step.title}{step.always && <em className="tagalways">always runs</em>}</h3>
          <span className="meta"><span className="st">{STATE_LABEL[step.state]}</span>{step.ms != null && <span className="dur">{fmtMs(step.ms)}</span>}</span>
        </header>
        {step.explain && <p className="explain">{step.explain}</p>}
        {step.state === 'skipped' && <p className="muted small">Skipped because an earlier step was blocked.</p>}
        {step.error && <p className="steperr" role="alert">{step.error}</p>}

        {!quiet && cmp && (
          <section className="io"><h4>What was checked</h4><CompareView req={io.request} state={step.state} /></section>
        )}
        {!quiet && io && !cmp && io.kind !== 'evidence' && (
          <>
            <section className="io"><h4>{REQ_LABEL[io.kind] || 'Request'}</h4><Request io={io} /></section>
            {pairBefore && beforeIo && beforeIo.response
              ? <section className="io"><h4>Before and after the run</h4><BeforeAfter before={beforeIo} after={io} afterState={step.state} /></section>
              : io.response && <section className="io"><h4>{RES_LABEL[io.kind] || 'Response'}</h4><Response io={io} />
                {isBefore && <p className="muted small">The same query runs again at the end; the two answers are compared in the last phase.</p>}</section>}
          </>
        )}
        {!quiet && io && io.kind === 'evidence' && <pre className="mono json">{pretty(io.evidence)}</pre>}
        {pairBefore && !io && step.state === 'running' && <p className="muted small">Waiting for the database...</p>}

        {failLogs.length > 0 && (
          <section className="io"><h4>First lines of the log{!step.logs.length && trigger ? ` from "${trigger.title}"` : ''}</h4>
            <ol className="logl">{failLogs.map((l, i) => <li key={i}>{l.line}</li>)}</ol></section>
        )}
        {/* a compare step's log only echoes the comparison shown above */}
        {!quiet && !cmp && <LogBox logs={step.logs} running={step.state === 'running'} />}
      </div>
    </li>
  );
}

export default function Timeline({ run, only }) {
  const pairs = comparePairs(run);
  return (
    <div className="timeline">
      {PHASES.filter((ph) => !only || ph === only).map((ph) => {
        const ids = run.order.filter((id) => run.steps[id].phase === ph);
        if (!ids.length) return null;
        return (
          <section key={ph} className={`phase p-${phaseState(run, ph)} ${only ? "solo" : ""}`} aria-labelledby={`ph-${ph}`}>
            <div className="phead"><h2 id={`ph-${ph}`}>{PHASE_NAME[ph]}</h2><p>{PHASE_HINT[ph]}</p></div>
            <ol className="steps">
              {ids.map((id) => <StepCard key={id} step={run.steps[id]} run={run} pairBefore={pairs.after.get(id)} isBefore={pairs.before.has(id)} />)}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
