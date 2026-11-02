import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { VerdictBadge, fmtTime, fmtMs, ErrorNote } from './ui.jsx';

// Runs carry only a scenario id, so titles are joined from the scenarios list here.
export default function History({ scenarioId }) {
  const [runs, setRuns] = useState(null);
  const [titles, setTitles] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRuns(null);
    api.listRuns(scenarioId).then(setRuns, (e) => setError(e.message));
    api.listScenarios().then((all) => setTitles(Object.fromEntries(all.map((s) => [s.id, s.title]))), () => {});
  }, [scenarioId]);

  const rerun = async () => {
    setBusy(true);
    try { location.hash = `#/run/${encodeURIComponent(await api.startRun(scenarioId))}`; }
    catch (e) { setError(e.message); setBusy(false); }
  };
  const titleOf = (r) => r.scenarioTitle || r.title || titles[r.scenarioId] || r.scenarioId;

  return (
    <section className="page">
      <nav className="crumbs"><a href="#/">Test board</a><span>/</span><span>History</span></nav>
      <div className="headrow">
        <h1>{scenarioId ? (titles[scenarioId] || scenarioId) : 'All runs'}</h1>
        {scenarioId && <button className="run" onClick={rerun} disabled={busy}>Run again</button>}
      </div>
      {scenarioId && titles[scenarioId] && <p className="muted"><code>{scenarioId}</code></p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {!runs && !error && <p className="note">Loading runs...</p>}
      {runs && runs.length === 0 && <p className="note">Nothing has run yet. Pick a scenario and press Run.</p>}
      {runs && runs.length > 0 && (
        <ul className="runs">
          {runs.map((r) => (
            <li key={r.runId}>
              <a className="runrow" href={`#/replay/${encodeURIComponent(r.runId)}`}>
                <VerdictBadge verdict={r.verdict} />
                <span className="rt">
                  <span className="rtt">{titleOf(r)}</span>
                  <span className="muted small">{fmtTime(r.startedAt)}{r.endedAt ? `, took ${fmtMs(Date.parse(r.endedAt) - Date.parse(r.startedAt))}` : ', in progress'}</span>
                </span>
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
