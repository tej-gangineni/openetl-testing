import React, { useEffect, useState } from 'react';
import Board from './components/Board.jsx';
import ScenarioPage from './components/ScenarioPage.jsx';
import RunView from './components/RunView.jsx';
import History from './components/History.jsx';
import { isMock } from './api.js';

// Hash routes keep the ?mock=1 query intact and need no server rewrite rules.
//   #/                   test board, level 1 (categories)
//   #/b/:cat/:sub        test board, levels 2 and 3
//   #/scenario/:id       one test case: what it involves, recent runs
//   #/run/:runId         live run (SSE)
//   #/replay/:runId      stored run, replayed with original timing
//   #/history/:scenario  past runs
function parse() {
  const [, kind, id, id2] = (location.hash || '#/').split('/');
  return { kind: kind || 'list', id: id ? decodeURIComponent(id) : null, id2: id2 ? decodeURIComponent(id2) : null };
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
  });
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'auto') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* storage may be blocked */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'auto' ? 'dark' : t === 'dark' ? 'light' : 'auto'))];
}

export default function App() {
  const [route, setRoute] = useState(parse);
  const [theme, cycle] = useTheme();
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/"><span className="mark" aria-hidden="true" />OpenETL <b>Test Board</b></a>
        {isMock && <span className="chip mockchip" title="Replaying a recorded sample, no backend needed">Mock mode</span>}
        <nav className="topnav"><a href="#/">Test board</a><a href="#/history">History</a></nav>
        <span className="grow" />
        <button className="ghost" onClick={cycle} aria-label={`Theme: ${theme}. Click to change.`}>Theme: {theme}</button>
      </header>
      <main>
        {route.kind === 'run' && <RunView key={route.id} runId={route.id} mode="live" />}
        {route.kind === 'replay' && <RunView key={route.id} runId={route.id} mode="replay" />}
        {route.kind === 'history' && <History key={route.id || 'all'} scenarioId={route.id} />}
        {route.kind === 'scenario' && <ScenarioPage key={route.id} id={route.id} />}
        {!['run', 'replay', 'history', 'scenario'].includes(route.kind) && <Board key="board" ci={route.kind === 'b' ? route.id : null} si={route.kind === 'b' ? route.id2 : null} />}
      </main>
    </div>
  );
}
