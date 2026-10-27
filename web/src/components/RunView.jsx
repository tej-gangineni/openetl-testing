import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api } from '../api.js';
import { replay } from '../replay.js';
import { runReducer, initialRun, phaseState, PHASES } from '../reducer.js';
import { StateIcon, STATE_LABEL, fmtMs, ErrorNote } from './ui.jsx';
import StepPanel from './StepPanel.jsx';

function Banner({ run, now, onReplay, canReplay }) {
  const c = run.counts;
  if (!run.verdict) {
    const running = Object.values(run.steps).some((s) => s.state === 'running');
    return (
      <div className="banner pending" role="status">
        <strong>{run.scenario ? (running ? 'Running' : 'Starting') : 'Queued'}</strong>
        <span>{run.scenario ? fmtMs(now - run.rxStart) : 'Waiting for the scheduler to pick this up.'}</span>
      </div>
    );
  }
  return (
    <div className={`banner v-${run.verdict.toLowerCase()}`} role="status">
      <strong>{run.verdict}</strong>
      <ul className="counts">
        <li><b>{c.pass}</b> pass</li><li><b>{c.fail}</b> fail</li><li><b>{c.blocked}</b> blocked</li><li><b>{c.skipped}</b> skipped</li>
      </ul>
      <span>{fmtMs(run.ms)}</span>
      {canReplay && <button className="ghost" onClick={onReplay}>Replay</button>}
    </div>
  );
}

export default function RunView({ runId, mode }) {
  const [run, dispatch] = useReducer(runReducer, initialRun);
  const [sel, setSel] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const events = useRef([]);
  const stop = useRef(() => {});

  const feed = useCallback((e) => { dispatch(e); }, []);
  const play = useCallback((evs) => {
    stop.current();
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
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [run.verdict]);

  const close = useCallback(() => setSel(null), []);
  const sc = run.scenario;
  const step = sel ? run.steps[sel] : null;

  return (
    <section className="page run-page">
      <nav className="crumbs">
        <a href="#/">Scenarios</a><span>/</span>
        {sc ? <a href={`#/history/${encodeURIComponent(sc.id)}`}>History</a> : <span>Run</span>}
        <span>/</span><code>{runId}</code>
        {mode === 'replay' && <span className="chip">Replay</span>}
      </nav>
      <div className="headrow">
        <div>
          <h1>{sc ? sc.title : 'Waiting for run'}</h1>
          {sc && <p className="muted"><code>{sc.tracker_row}</code> <span className="sid">{sc.id}</span> {sc.tags.map((t) => <span key={t} className="tag">{t}</span>)}</p>}
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Banner run={run} now={now} canReplay={!!run.verdict && events.current.length > 0} onReplay={() => { setSel(null); play(events.current); }} />

      <div className="pipeline" aria-label="Pipeline">
        {PHASES.map((ph, i) => {
          const ids = run.order.filter((id) => run.steps[id].phase === ph);
          const ps = phaseState(run, ph);
          return (
            <React.Fragment key={ph}>
              {i > 0 && <div className={`link ${phaseState(run, PHASES[i - 1]) === 'pass' || ps !== 'waiting' ? 'lit' : ''}`} aria-hidden="true" />}
              <section className={`phase p-${ps}`} aria-label={ph}>
                <h3><span>{ph}</span><em>{ids.length}</em></h3>
                <div className="nodes">
                  {ids.length === 0 && <p className="muted small empty">{sc ? 'No steps' : '...'}</p>}
                  {ids.map((id) => {
                    const s = run.steps[id];
                    return (
                      <button key={id} className={`node s-${s.state} ${sel === id ? 'sel' : ''}`} onClick={() => setSel(id)} aria-label={`${s.title}: ${STATE_LABEL[s.state]}`}>
                        <span className="ico"><StateIcon state={s.state} /></span>
                        <span className="ntext">
                          <span className="ntitle">{s.title}</span>
                          <span className="nsub">{STATE_LABEL[s.state]}{s.ms != null ? ` · ${fmtMs(s.ms)}` : ''}{s.logs.length ? ` · ${s.logs.length} lines` : ''}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </React.Fragment>
          );
        })}
      </div>
      <StepPanel step={step} phase={step && step.phase} onClose={close} />
    </section>
  );
}
