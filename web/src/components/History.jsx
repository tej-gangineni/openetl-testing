import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { VerdictBadge, fmtTime, fmtMs, ErrorNote } from './ui.jsx';

export default function History({ scenarioId }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listRuns(scenarioId).then(setRuns, (e) => setError(e.message)); }, [scenarioId]);

  const rerun = async () => {
    setBusy(true);
    try { location.hash = `#/run/${encodeURIComponent(await api.startRun(scenarioId))}`; }
    catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <section className="page">
      <nav className="crumbs"><a href="#/">Scenarios</a><span>/</span><span>History</span></nav>
      <div className="headrow">
        <h1 title={scenarioId}>{scenarioId}</h1>
        <button className="run" onClick={rerun} disabled={busy}>Run again</button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!runs && !error && <p className="note">Loading runs...</p>}
      {runs && runs.length === 0 && <p className="note">This scenario has not been run yet.</p>}
      {runs && runs.length > 0 && (
        <ul className="runs">
          {runs.map((r) => (
            <li key={r.runId}>
              <a className="runrow" href={`#/replay/${encodeURIComponent(r.runId)}`}>
                <VerdictBadge verdict={r.verdict} />
                <span className="when">{fmtTime(r.startedAt)}</span>
                <span className="muted small dur">{r.endedAt ? fmtMs(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : 'in progress'}</span>
                <code className="rid">{r.runId}</code>
                <span className="open">Replay</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
