import React from 'react';

export function VerdictBadge({ verdict }) {
  const v = verdict || 'none';
  return <span className={`badge v-${v.toLowerCase()}`}><i />{verdict || 'No runs'}</span>;
}

const P = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

// Step state mark. Keyed by state in the caller so it replays its entrance
// animation exactly when the state changes.
export function StateIcon({ state, size = 16 }) {
  const p = { ...P, width: size, height: size };
  switch (state) {
    case 'pass': return <svg {...p} className="draw"><path d="M3 8.5l3.2 3L13 4.5" pathLength="1" /></svg>;
    case 'fail': return <svg {...p} className="draw"><path d="M4 4l8 8M12 4l-8 8" pathLength="1" /></svg>;
    case 'blocked': return <svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></svg>;
    case 'skipped': return <svg {...p}><path d="M3 8h10" strokeDasharray="2 2.4" /></svg>;
    case 'running': return <svg {...p} className="spin"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" /></svg>;
    default: return <svg {...p}><circle cx="8" cy="8" r="2.2" /></svg>;
  }
}

export const STATE_LABEL = { waiting: 'Waiting', running: 'Running', pass: 'Pass', fail: 'Fail', blocked: 'Blocked', skipped: 'Skipped' };

// Simple line icons for the flow diagram; no emoji, colour from currentColor.
export function KindIcon({ kind, size = 26 }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  const cyl = (<><ellipse cx="12" cy="5.5" rx="7" ry="2.7" /><path d="M5 5.5v13c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7v-13" /></>);
  switch (kind) {
    case 'files': return <svg {...p}><path d="M7 3h7l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v4h4M9 12h6M9 15.5h6" /></svg>;
    case 'http': return <svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.6 2.4 3.6 5.3 3.6 8.5s-1 6.1-3.6 8.5c-2.6-2.4-3.6-5.3-3.6-8.5s1-6.1 3.6-8.5z" /></svg>;
    case 'clickhouse': return <svg {...p}><path d="M5 4v16M9.5 4v16M14 4v16M18.5 9v6" /></svg>;
    case 'elasticsearch': return <svg {...p}><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></svg>;
    case 'qdrant': return <svg {...p}>{[6, 12, 18].flatMap((x) => [6, 12, 18].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.5" />))}</svg>;
    case 'relata': return <svg {...p}><circle cx="6" cy="7" r="2.3" /><circle cx="18" cy="7" r="2.3" /><circle cx="12" cy="18" r="2.3" /><path d="M8 8.2l2.6 7.6M16 8.2l-2.6 7.6M8.3 7h7.4" /></svg>;
    case 'docker': return <svg {...p}><rect x="3.5" y="9" width="17" height="9" rx="1.5" /><path d="M8 9V6M12 9V6M16 9V6M7 13.5h2M11 13.5h2M15 13.5h2" /></svg>;
    case 'engine': return <svg {...p}><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg>;
    default: return <svg {...p}>{cyl}</svg>;   // postgres, mongodb and any other database
  }
}

export function fmtMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const fmtN = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : n);

export function ErrorNote({ children }) { return <p className="note err" role="alert">{children}</p>; }
