import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { CATS, ALL_ROWS, scenarioRows } from '../catalog.js';
import { VerdictBadge, KindIcon, fmtTime, fmtMs, ErrorNote } from './ui.jsx';
import Flow from './Flow.jsx';

const KIND_NAME = { files: 'Files', http: 'HTTP endpoint', postgres: 'PostgreSQL', mongodb: 'MongoDB', clickhouse: 'ClickHouse', elasticsearch: 'Elasticsearch', qdrant: 'Qdrant', relata: 'Relata', docker: 'Docker' };

export default function ScenarioPage({ id }) {
  const [sc, setSc] = useState(undefined);
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.listScenarios().then((all) => setSc(all.find((s) => s.id === id) || null), (e) => setError(e.message));
    api.listRuns(id).then(setRuns, () => setRuns([]));
  }, [id]);

  const rows = useMemo(() => (sc ? scenarioRows(sc).map((r) => ALL_ROWS.find((x) => x.id === r)).filter(Boolean) : []), [sc]);
  const place = rows[0] && CATS.find((c) => c.comps.includes(rows[0].comp));
  const si = place ? place.subs.findIndex((s) => s.name === rows[0].sub) : -1;

  const run = async () => {
    setBusy(true); setError('');
    try { location.hash = `#/run/${encodeURIComponent(await api.startRun(id))}`; }
    catch (e) { setError(e.message); setBusy(false); }
  };

  if (sc === undefined && !error) return <section className="page"><p className="note">Loading...</p></section>;
  if (!sc) return <section className="page"><nav className="crumbs"><a href="#/">Test board</a></nav>{error ? <ErrorNote>{error}</ErrorNote> : <p className="note">No scenario called {id}.</p>}</section>;

  const f = sc.flow;
  const last = sc.lastRun;
  return (
    <section className="page scen">
      <nav className="crumbs">
        <a href="#/">Test board</a>
        {place && <><span>/</span><a href={`#/b/${place.i}`}>{place.name}</a><span>/</span><a href={`#/b/${place.i}/${si}`}>{rows[0].sub}</a></>}
        <span>/</span><span>{sc.id}</span>
      </nav>
      {error && <ErrorNote>{error}</ErrorNote>}
      <header className="rhead">
        <div className="rtitle">
          <h1>{sc.title}</h1>
          <p className="rmeta">{(sc.tracker_row || '').split(/,\s*/).map((r) => <code key={r}>{r}</code>)}{(sc.tags || []).map((t) => <span key={t} className="tag">{t}</span>)}</p>
          {sc.summary && <p className="summary">{sc.summary}</p>}
        </div>
        <div className="runbox">
          <VerdictBadge verdict={last && last.verdict} />
          {last && <span className="muted small">Last run {fmtTime(last.ts)}</span>}
          <button type="button" className="run" disabled={busy} onClick={run}>{busy ? 'Queuing' : 'Run this test'}</button>
        </div>
      </header>

      <h2 className="sech">What this test involves</h2>
      <Flow flow={f} touch={null} counts={{}} running={false} />
      <div className="involves">
        <div className="inode" style={{ '--i': 0 }}><span className="k">Source</span><span className="v"><KindIcon kind={f.source.kind} size={20} />{KIND_NAME[f.source.kind] || f.source.kind}</span><span className="d">{f.source.label}</span></div>
        <div className="inode" style={{ '--i': 1 }}><span className="k">Pipeline</span><span className="v"><KindIcon kind="engine" size={20} />OpenETL</span><span className="d">{f.engine.label}</span></div>
        <div className="inode" style={{ '--i': 2 }}><span className="k">Destination</span><span className="v"><KindIcon kind={f.target.kind} size={20} />{KIND_NAME[f.target.kind] || f.target.kind}</span><span className="d">{f.target.label}</span></div>
        {(sc.resources || []).length > 0 && <div className="inode" style={{ '--i': 3 }}><span className="k">Shared services used</span><span className="v">{sc.resources.join(', ')}</span><span className="d">Two tests that share a service never run at the same time.</span></div>}
      </div>

      {rows.length > 0 && <>
        <h2 className="sech">Capability it proves</h2>
        <div className="caprows">
          {rows.map((r) => (
            <div key={r.id} className="capnode"><span className="num">#{r.n}</span><b>{r.cap}</b>
              <span className={`pill t-${r.today || 'none'}`}>Today {r.today || '—'}</span><span className={`pill t-${r.target || 'none'}`}>Target {r.target || '—'}</span>
              <span className="muted small">Lands in {r.lands} · {r.comp}</span></div>
          ))}
        </div>
      </>}

      <h2 className="sech">Recent runs</h2>
      {!runs && <p className="note">Loading...</p>}
      {runs && runs.length === 0 && <p className="note">Not run yet. Press "Run this test".</p>}
      {runs && runs.length > 0 && (
        <ul className="runlist">
          {runs.slice(0, 8).map((r, i) => (
            <li key={r.runId} style={{ '--i': i }}>
              <VerdictBadge verdict={r.verdict} />
              <a href={`#/replay/${encodeURIComponent(r.runId)}`}>{fmtTime(r.startedAt)}</a>
              <span className="muted small">{r.endedAt ? fmtMs(new Date(r.endedAt) - new Date(r.startedAt)) : 'running'}</span>
              <a className="muted small" href={`#/replay/${encodeURIComponent(r.runId)}`}>Replay ›</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
