import React, { useEffect, useState } from 'react';
import ScenarioList from './components/ScenarioList.jsx';
import RunView from './components/RunView.jsx';
import History from './components/History.jsx';
import { isMock } from './api.js';

// Hash routes keep the ?mock=1 query intact and need no server rewrite rules.
//   #/                   scenario list
//   #/run/:runId         live run (SSE)
//   #/replay/:runId      stored run, replayed with original timing
//   #/history/:scenario  past runs
function parse() {
  const [, kind, id] = (location.hash || '#/').split('/');
  return { kind: kind || 'list', id: id ? decodeURIComponent(id) : null };
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
        <a className="brand" href="#/"><span className="mark" aria-hidden="true" />OpenETL <b>Test Runner</b></a>
        {isMock && <span className="chip mockchip" title="Replaying a recorded sample, no backend needed">Mock mode</span>}
        <nav className="topnav"><a href="#/">Scenarios</a><a href="#/history">History</a></nav>
        <span className="grow" />
        <button className="ghost" onClick={cycle} aria-label={`Theme: ${theme}. Click to change.`}>Theme: {theme}</button>
      </header>
      <main>
        {route.kind === 'run' && <RunView key={route.id} runId={route.id} mode="live" />}
        {route.kind === 'replay' && <RunView key={route.id} runId={route.id} mode="replay" />}
        {route.kind === 'history' && <History key={route.id || 'all'} scenarioId={route.id} />}
        {!['run', 'replay', 'history'].includes(route.kind) && <ScenarioList />}
      </main>
    </div>
  );
}
