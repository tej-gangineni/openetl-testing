import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from '../api.js';
import { replay } from '../replay.js';
import { runReducer, initialRun, counters, touching, PHASES, PHASE_NAME, PHASE_HINT, phaseState } from '../reducer.js';
import { StateIcon } from './ui.jsx';
import { fmtMs, fmtN, ErrorNote } from './ui.jsx';
import Flow from './Flow.jsx';
import Timeline from './Timeline.jsx';

function Verdict({ run, now, onReplay, canReplay }) {
  const total = run.order.length;
  const done = run.order.filter((id) => ['pass', 'fail', 'blocked', 'skipped'].includes(run.steps[id].state)).length;
  if (!run.verdict) {
    return (
      <div className="verdict pending" role="status">
        <span className="vword">{run.scenario ? 'Running' : 'Queued'}</span>
        <span className="vsub">{run.scenario ? `Step ${Math.min(done + 1, total)} of ${total}, ${fmtMs(now - run.rxStart)} so far` : 'Waiting for the scheduler to pick this up.'}</span>
        {run.scenario && <span className="bar" aria-hidden="true"><i style={{ width: `${(done / Math.max(total, 1)) * 100}%` }} /></span>}
      </div>
    );
  }
  const c = run.counts || { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  const lines = { Pass: 'Everything checked out.', Fail: 'At least one check did not match.', Blocked: 'The run could not finish a step.' };
  return (
    <div className={`verdict v-${run.verdict.toLowerCase()}`} role="status">
      <span className="vword">{run.verdict}</span>
      <span className="vsub">{lines[run.verdict]}{run.note ? ` (${run.note})` : ''}</span>
      <ul className="vcounts">
        <li><b>{fmtN(c.pass)}</b> passed</li>
        {c.fail > 0 && <li className="f"><b>{fmtN(c.fail)}</b> failed</li>}
        {c.blocked > 0 && <li className="b"><b>{fmtN(c.blocked)}</b> blocked</li>}
        {c.skipped > 0 && <li><b>{fmtN(c.skipped)}</b> skipped</li>}
        <li>{fmtMs(run.ms)}</li>
      </ul>
      {canReplay && <button className="ghost" onClick={onReplay}>Replay this run</button>}
    </div>
  );
}


// The four phases as connected nodes. Click one to see just its steps.
function PhaseChain({ run, selected, onSelect }) {
  const phases = PHASES.filter((ph) => run.order.some((id) => run.steps[id].phase === ph));
  return (
    <div className="pchain" role="tablist" aria-label="Phases of this test">
      {phases.map((ph, idx) => {
        const ids = run.order.filter((id) => run.steps[id].phase === ph), ps = phaseState(run, ph);
        const done = ids.filter((id) => ['pass', 'fail', 'blocked', 'skipped'].includes(run.steps[id].state)).length;
        return (
          <React.Fragment key={ph}>
            {idx > 0 && <span className={`pedge ${ps === 'running' || ps === 'pass' || ps === 'fail' || ps === 'blocked' ? 'on' : ''} ${ps === 'running' ? 'live' : ''}`} aria-hidden="true" />}
            <button type="button" role="tab" aria-selected={selected === ph} className={`pnode p-${ps} ${selected === ph ? 'sel' : ''}`} style={{ '--i': idx }} onClick={() => onSelect(ph)}>
              <span className="pn">Step {idx + 1}</span>
              <span className="ptitle"><span className="pmk" key={ps}><StateIcon state={ps === 'waiting' || ps === 'empty' ? 'waiting' : ps} size={15} /></span>{PHASE_NAME[ph]}</span>
              <span className="phint">{PHASE_HINT[ph]}</span>
              <span className="pdots" aria-hidden="true">{ids.map((id) => <i key={id} className={`d-${run.steps[id].state}`} title={run.steps[id].title} />)}</span>
              <span className="pcount">{done}/{ids.length} steps</span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default function RunView({ runId, mode }) {
  const [run, dispatch] = useReducer(runReducer, initialRun);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const events = useRef([]);
  const stop = useRef(() => {});
  const scrolled = useRef(false);
  const [picked, setPicked] = useState(null);

  const feed = useCallback((e) => { dispatch(e); }, []);
  const play = useCallback((evs) => {
    stop.current();
    scrolled.current = false;
    dispatch({ type: 'reset' });
    stop.current = replay(evs, feed);
  }, [feed]);

  useEffect(() => {
    let alive = true;
    if (mode === 'replay') {
      api.getRun(runId).then((r) => { if (alive) { events.current = r.events; play(r.events); } }, (e) => alive && setError(e.message));
    } else {
      stop.current = api.subscribe(runId, (e) => { events.current.push(e); feed(e); }, null, (e) => setError(e.message));
    }
    return () => { alive = false; stop.current(); };
  }, [runId, mode, play, feed]);

  useEffect(() => {
    if (run.verdict) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [run.verdict]);

  // A run that did not pass: bring the first failing step into view.
  useEffect(() => {
    if (!run.verdict || run.verdict === 'Pass' || scrolled.current) return;
    scrolled.current = true;
    const id = run.order.find((i) => run.steps[i].state === 'fail') || run.order.find((i) => run.steps[i].state === 'blocked');
    const el = id && document.getElementById(`step-${id}`);
    if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }, [run.verdict, run.order, run.steps]);

  const sc = run.scenario;
  const count = useMemo(() => counters(run), [run]);
  const running = !!sc && !run.verdict;
  // Follow the live phase; once the run ends, open the first phase that did not pass.
  const auto = (() => {
    const phs = PHASES.filter((ph) => run.order.some((id) => run.steps[id].phase === ph));
    if (!phs.length) return null;
    return phs.find((ph) => phaseState(run, ph) === 'running') || phs.find((ph) => ['fail', 'blocked'].includes(phaseState(run, ph)))
      || (run.verdict ? phs[phs.length - 1] : phs.find((ph) => phaseState(run, ph) === 'waiting') || phs[0]);
  })();
  const selected = picked || auto;

  return (
    <section className="page run-page">
      <nav className="crumbs">
        <a href="#/">Test board</a><span>/</span>
        {sc ? <a href={`#/scenario/${encodeURIComponent(sc.id)}`}>{sc.title}</a> : <span>Run</span>}
        <span>/</span><code>{runId}</code>
        {mode === 'replay' && <span className="chip">Replay</span>}
      </nav>
      {error && <ErrorNote>{error}</ErrorNote>}
      <header className="rhead">
        <div className="rtitle">
          <h1>{sc ? sc.title : 'Waiting for the run to start'}</h1>
          {sc && <p className="rmeta"><code>{sc.tracker_row}</code>{(sc.tags || []).map((t) => <span key={t} className="tag">{t}</span>)}</p>}
          {sc && sc.summary && <p className="summary">{sc.summary}</p>}
        </div>
        <Verdict run={run} now={now} canReplay={!!run.verdict && events.current.length > 0} onReplay={() => play(events.current)} />
      </header>
      {sc && <Flow flow={sc.flow} touch={running ? touching(run) : null} counts={count} running={running} />}
      <h2 className="sech">Step by step</h2>
      <PhaseChain run={run} selected={selected} onSelect={setPicked} />
      {picked && <p className="note small">Showing {PHASE_NAME[picked]}. <button type="button" className="link" onClick={() => setPicked(null)}>Follow the run</button></p>}
      <div className="pbody" key={selected}><Timeline run={run} only={selected} /></div>
    </section>
  );
}
