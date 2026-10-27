import React, { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import { api } from '../api.js';
import { VerdictBadge, fmtTime, ErrorNote } from './ui.jsx';

/*
 * Performance with ~2,000 rows: all scenarios are fetched once and filtered in
 * memory (cheap), and the list is windowed. Rows have a fixed height, so the
 * visible slice is computed from scrollTop with no measuring; only ~15 DOM
 * rows exist at a time. Chosen over pagination because testers scan and
 * search, and a scroll position is easier to keep than a page number.
 */
const OVERSCAN = 6;

function VirtualList({ items, render }) {
  const ref = useRef(null);
  const [view, setView] = useState({ top: 0, h: 600, w: 1000 });
  const rowH = view.w < 640 ? 112 : 76;
  useEffect(() => {
    const el = ref.current;
    const measure = () => setView((v) => ({ ...v, h: el.clientHeight, w: el.clientWidth }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (ref.current) ref.current.scrollTop = 0; }, [items]);
  const first = Math.max(0, Math.floor(view.top / rowH) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((view.top + view.h) / rowH) + OVERSCAN);
  return (
    <div className="vlist" ref={ref} onScroll={(e) => { const top = e.currentTarget.scrollTop; setView((v) => (v.top === top ? v : { ...v, top })); }}>
      <div style={{ height: items.length * rowH, position: 'relative' }} role="list">
        {items.slice(first, last).map((it, k) => (
          <div key={it.id} role="listitem" className="vrow" style={{ top: (first + k) * rowH, height: rowH }}>{render(it)}</div>
        ))}
      </div>
    </div>
  );
}

export default function ScenarioList() {
  const [all, setAll] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState(null);
  const dq = useDeferredValue(q);

  useEffect(() => { api.listScenarios().then(setAll, (e) => setError(e.message)); }, []);

  const allTags = useMemo(() => {
    const c = new Map();
    for (const s of all || []) for (const t of s.tags || []) c.set(t, (c.get(t) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [all]);

  const shown = useMemo(() => {
    const needle = dq.trim().toLowerCase();
    return (all || []).filter((s) =>
      tags.every((t) => s.tags.includes(t)) &&
      (!needle || `${s.title} ${s.id} ${s.tracker_row} ${s.tags.join(' ')}`.toLowerCase().includes(needle)));
  }, [all, dq, tags]);

  const run = async (id) => {
    setBusy(id); setError('');
    try { location.hash = `#/run/${encodeURIComponent(await api.startRun(id))}`; }
    catch (e) { setError(e.message); setBusy(null); }
  };
  const toggle = (t) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  return (
    <section className="page list-page">
      <div className="toolbar">
        <label className="search">
          <span className="sr">Search scenarios</span>
          <input type="search" placeholder="Search title, id, tracker row or tag" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="count" aria-live="polite">{all ? `${shown.length} of ${all.length}` : ''}</span>
      </div>
      {allTags.length > 0 && (
        <div className="chips" role="group" aria-label="Filter by tag">
          {allTags.map(([t, n]) => (
            <button key={t} className={`chip ${tags.includes(t) ? 'on' : ''}`} aria-pressed={tags.includes(t)} onClick={() => toggle(t)}>{t}<em>{n}</em></button>
          ))}
          {tags.length > 0 && <button className="chip clear" onClick={() => setTags([])}>Clear</button>}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {!all && !error && <p className="note">Loading scenarios...</p>}
      {all && shown.length === 0 && <p className="note">No scenarios match.</p>}
      {all && shown.length > 0 && (
        <VirtualList items={shown} render={(s) => (
          <div className="srow">
            <div className="smain">
              <a className="stitle" href={`#/history/${encodeURIComponent(s.id)}`} title={s.title}>{s.title}</a>
              <div className="smeta">
                <code>{s.tracker_row}</code>
                <span className="sid" title={s.id}>{s.id}</span>
                <span className="muted">{s.stepCount} steps</span>
              </div>
              <div className="stags">{s.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
            </div>
            <div className="sside">
              <VerdictBadge verdict={s.lastRun && s.lastRun.verdict} />
              {s.lastRun && <span className="muted small">{fmtTime(s.lastRun.ts)}</span>}
            </div>
            <button className="run" disabled={busy === s.id} onClick={() => run(s.id)} aria-label={`Run ${s.title}`}>{busy === s.id ? 'Queuing' : 'Run'}</button>
          </div>
        )} />
      )}
    </section>
  );
}
