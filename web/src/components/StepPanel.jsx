import React, { useEffect, useRef } from 'react';
import { StateIcon, STATE_LABEL, fmtMs } from './ui.jsx';

const OPS = { eq: 'equals', ne: 'not equal', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most', contains: 'contains' };
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function isCompare(ev) {
  return ev && typeof ev === 'object' && 'left' in ev && 'op' in ev && 'right' in ev;
}

function Compare({ ev, state }) {
  const rest = Object.fromEntries(Object.entries(ev).filter(([k]) => !['left', 'op', 'right'].includes(k)));
  return (
    <>
      <div className={`compare ${state}`}>
        <div><h4>Left</h4><pre>{show(ev.left)}</pre></div>
        <div className="op"><h4>Operator</h4><b>{ev.op}</b><span>{OPS[ev.op] || ''}</span></div>
        <div><h4>Right</h4><pre>{show(ev.right)}</pre></div>
      </div>
      {Object.keys(rest).length > 0 && <pre className="json">{JSON.stringify(rest, null, 2)}</pre>}
    </>
  );
}

export default function StepPanel({ step, phase, onClose }) {
  const logRef = useRef(null);
  useEffect(() => {
    const el = logRef.current;
    if (el && step && step.state === 'running') el.scrollTop = el.scrollHeight;
  }, [step && step.logs.length, step && step.state]);
  useEffect(() => {
    const on = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  if (!step) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="panel" role="dialog" aria-label={`Step ${step.title}`}>
        <header>
          <div>
            <span className="eyebrow">{phase} / {step.id}</span>
            <h2>{step.title}</h2>
            <span className={`pstate s-${step.state}`}><StateIcon state={step.state} />{STATE_LABEL[step.state]}{step.ms != null && <em>{fmtMs(step.ms)}</em>}</span>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close panel">Close</button>
        </header>
        <div className="pbody">
          {step.error && <p className="note err">{step.error}</p>}
          <h3>Log <span className="muted">{step.logs.length} lines</span></h3>
          {step.logs.length === 0
            ? <p className="muted small">{step.state === 'skipped' ? 'Skipped because an earlier step was blocked.' : 'No output yet.'}</p>
            : <ol className="log" ref={logRef}>{step.logs.map((l, i) => <li key={i}><span>{i + 1}</span><code>{l}</code></li>)}</ol>}
          <h3>Evidence</h3>
          {step.evidence === undefined
            ? <p className="muted small">None recorded.</p>
            : isCompare(step.evidence) ? <Compare ev={step.evidence} state={step.state} />
            : <pre className="json">{JSON.stringify(step.evidence, null, 2)}</pre>}
        </div>
      </aside>
    </>
  );
}
