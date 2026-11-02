import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { CATS, ALL_ROWS, coverage, summarise, rowVerdict } from '../catalog.js';
import { VerdictBadge, fmtTime, ErrorNote } from './ui.jsx';

/*
 * Test board: three zoom levels shown as connected nodes.
 *   #/            1  categories      (ten)
 *   #/b/2         2  sub-components  of category 2
 *   #/b/2/1       3  test cases      of that sub-component
 * A test case with a scenario opens its page (#/scenario/:id); the rest are
 * shown as "not automated yet" so the full coverage picture is always visible.
 */

const COL = { Pass: 'var(--pass)', Fail: 'var(--fail)', Blocked: 'var(--blocked)', notRun: 'var(--run)' };

function ringStyle(sum) {
  const t = Math.max(sum.total, 1);
  let at = 0; const parts = [];
  for (const k of ['Pass', 'Fail', 'Blocked', 'notRun']) {
    if (!sum[k]) continue;
    const w = (100 * sum[k]) / t;
    parts.push(`${COL[k]} ${at}% ${at + w}%`); at += w;
  }
  parts.push(`var(--surface2) ${at}% 100%`);
  return { '--segs': parts.join(',') };
}

function Ring({ sum, big }) {
  return (
    <span className={`ring ${big ? 'lg' : ''}`} style={ringStyle(sum)} role="img" aria-label={`${sum.automated} of ${sum.total} automated`}>
      <span>{sum.automated}<small>/{sum.total}</small></span>
    </span>
  );
}

function Node({ i = 0, className = '', children, ...rest }) {
  const Tag = rest.href ? 'a' : rest.onClick ? 'button' : 'div';
  return <Tag className={`bnode ${className}`} style={{ '--i': i }} {...(Tag === 'button' ? { type: 'button' } : {})} {...rest}>{children}</Tag>;
}

function Stats({ sum }) {
  const bits = [];
  if (sum.Pass) bits.push(<span key="p" className="ok">{sum.Pass} pass</span>);
  if (sum.Fail) bits.push(<span key="f" className="bad">{sum.Fail} fail</span>);
  if (sum.Blocked) bits.push(<span key="b" className="warn">{sum.Blocked} blocked</span>);
  if (sum.notRun) bits.push(<span key="n">{sum.notRun} not run yet</span>);
  if (!sum.automated) bits.push(<span key="x" className="muted">none automated yet</span>);
  return <span className="bstats">{bits}</span>;
}

// Curved connectors from the parent node to every child node, drawn in on mount.
function Links({ stageRef, parentRef, kidsRef, deps }) {
  const [paths, setPaths] = useState([]);
  useLayoutEffect(() => {
    const calc = () => {
      const st = stageRef.current, par = parentRef.current, kids = kidsRef.current;
      if (!st || !par || !kids || window.innerWidth <= 860) { setPaths([]); return; }
      const sr = st.getBoundingClientRect(), pr = par.getBoundingClientRect();
      const x1 = pr.right - sr.left, y1 = pr.top - sr.top + Math.min(pr.height, 150) / 2;
      setPaths([...kids.children].map((k) => {
        const kr = k.getBoundingClientRect();
        const x2 = kr.left - sr.left, y2 = kr.top - sr.top + Math.min(kr.height, 90) / 2, mid = (x1 + x2) / 2;
        return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
      }));
    };
    calc();
    const t = setTimeout(calc, 650);   // after the entrance animation settles
    window.addEventListener('resize', calc);
    return () => { clearTimeout(t); window.removeEventListener('resize', calc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return (
    <svg className="blinks" aria-hidden="true">
      {paths.map((d, i) => <path key={d + i} d={d} pathLength="1" style={{ animationDelay: `${120 + i * 30}ms` }} />)}
    </svg>
  );
}

function Steps({ ci, si, cat, sub, row }) {
  const items = [
    ['1', 'Category', cat ? cat.name : 'Choose a category', '#/'],
    ['2', 'Sub-component', sub ? sub.name : 'Choose a sub-component', cat ? `#/b/${ci}` : null],
    ['3', 'Test case', row ? 'Open a test case' : 'Choose a test case', sub ? `#/b/${ci}/${si}` : null],
  ];
  const cur = sub ? 3 : cat ? 2 : 1;
  return (
    <nav className="bsteps" aria-label="Steps">
      {items.map(([n, k, v, href], idx) => {
        const cls = `bstep ${Number(n) === cur ? 'on' : ''} ${Number(n) < cur ? 'done' : ''}`;
        const body = <><span className="k">{n} · {k}</span><span className="v">{v}</span></>;
        return href && Number(n) !== cur ? <a key={n} className={cls} href={href}>{body}</a> : <span key={n} className={cls} aria-current={Number(n) === cur ? 'step' : undefined}>{body}</span>;
      })}
    </nav>
  );
}

export default function Board({ ci: ciS, si: siS }) {
  const [all, setAll] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [dir, setDir] = useState('fwd');
  const prev = useRef(0);
  const ci = ciS == null ? -1 : Number(ciS), si = siS == null ? -1 : Number(siS);
  const cat = CATS[ci], sub = cat && cat.subs[si];
  const level = sub ? 3 : cat ? 2 : 1;
  useEffect(() => { setDir(level >= prev.current ? 'fwd' : 'back'); prev.current = level; }, [level]);
  useEffect(() => { api.listScenarios().then(setAll, (e) => setError(e.message)); }, []);
  const cov = useMemo(() => coverage(all), [all]);

  const stageRef = useRef(null), parentRef = useRef(null), kidsRef = useRef(null);
  const total = useMemo(() => summarise(ALL_ROWS, cov), [cov]);

  const run = async (id) => {
    setBusy(id); setError('');
    try { location.hash = `#/run/${encodeURIComponent(await api.startRun(id))}`; }
    catch (e) { setError(e.message); setBusy(null); }
  };

  let parent, kids;
  if (level === 1) {
    parent = <Node className="big hub"><Ring sum={total} big /><span><span className="bt">OpenETL</span><span className="bs">{ALL_ROWS.length} test cases · {CATS.length} categories</span><Stats sum={total} /></span></Node>;
    kids = CATS.map((c, i) => {
      const sum = summarise(c.rows, cov);
      return <Node key={c.name} i={i} className={`kid ${sum.automated ? 'live' : ''}`} href={`#/b/${i}`}>
        <Ring sum={sum} />
        <span className="bbody"><span className="bt">{c.name}</span><span className="bs">{c.blurb}</span>
          <span className="bs">{c.subs.length} sub-components · {c.rows.length} test cases</span><Stats sum={sum} /></span>
        <span className="go">›</span></Node>;
    });
  } else if (level === 2) {
    const sum = summarise(cat.rows, cov);
    parent = <Node className="big"><Ring sum={sum} big /><span><span className="bt">{cat.name}</span><span className="bs">{cat.blurb}</span><Stats sum={sum} /></span></Node>;
    kids = cat.subs.map((s, i) => {
      const ss = summarise(s.rows, cov);
      return <Node key={s.name} i={i} className={`kid ${ss.automated ? 'live' : ''}`} href={`#/b/${ci}/${i}`}>
        <Ring sum={ss} />
        <span className="bbody"><span className="bt">{s.name}</span><span className="bs">{s.rows.length} test {s.rows.length === 1 ? 'case' : 'cases'}</span><Stats sum={ss} /></span>
        <span className="go">›</span></Node>;
    });
  } else {
    const sum = summarise(sub.rows, cov);
    parent = <Node className="big"><Ring sum={sum} big /><span><span className="bs caps">{cat.name}</span><span className="bt">{sub.name}</span><span className="bs">{sub.rows.length} test cases</span><Stats sum={sum} /></span></Node>;
    kids = sub.rows.map((r, i) => {
      const list = cov.get(r.id), v = rowVerdict(list), sc = list && list[0];
      return (
        <Node key={r.id} i={i} className={`kid case ${sc ? 'live' : 'idle'}`} {...(sc ? { href: `#/scenario/${encodeURIComponent(sc.id)}` } : {})}>
          <span className="crow1"><span className="num">#{r.n}</span><span className="bt">{r.cap}</span></span>
          <span className="crow2">
            <span className={`pill t-${r.today || 'none'}`}>Today {r.today || '—'}</span>
            <span className={`pill t-${r.target || 'none'}`}>Target {r.target || '—'}</span>
            <span className="muted small">{r.lands}</span>
          </span>
          {sc ? (
            <span className="crow3">
              <span className="auto"><i />Automated</span>
              <span className="muted small ctitle">{sc.title}</span>
              <VerdictBadge verdict={v} />
              {sc.lastRun && <span className="muted small">{fmtTime(sc.lastRun.ts)}</span>}
              <button type="button" className="run sm" disabled={busy === sc.id} onClick={(e) => { e.preventDefault(); e.stopPropagation(); run(sc.id); }}>{busy === sc.id ? 'Queuing' : 'Run'}</button>
            </span>
          ) : <span className="crow3"><span className="muted small">Not automated yet · tracker status: {r.status}</span></span>}
        </Node>
      );
    });
  }

  return (
    <section className="page board">
      <div className="boardhead">
        <div>
          <span className="eyebrow">OpenETL · test board</span>
          <h1>What we test, and how each test runs</h1>
        </div>
        <div className="legend" aria-label="Legend">
          <span><i style={{ background: 'var(--pass)' }} />Pass</span><span><i style={{ background: 'var(--fail)' }} />Fail</span>
          <span><i style={{ background: 'var(--blocked)' }} />Blocked</span><span><i style={{ background: 'var(--run)' }} />Automated, not run</span>
          <span><i style={{ background: 'var(--surface2)', border: '1px solid var(--line)' }} />Not automated yet</span>
        </div>
      </div>
      <Steps ci={ci} si={si} cat={cat} sub={sub} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!all && !error && <p className="note">Loading...</p>}
      <div className={`bstage enter-${dir}`} ref={stageRef} key={`${ci}/${si}`}>
        <Links stageRef={stageRef} parentRef={parentRef} kidsRef={kidsRef} deps={[ci, si, all]} />
        <div className="bparent" ref={parentRef}>{parent}</div>
        <div className="bkids" ref={kidsRef}>{kids}</div>
      </div>
      <p className="note small">{level === 1 ? 'Click a category to open it.' : level === 2 ? 'Click a sub-component to see its test cases.' : 'Automated test cases open their page; "Run" starts the test straight away.'}</p>
    </section>
  );
}
