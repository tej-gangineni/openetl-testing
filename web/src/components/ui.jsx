import React from 'react';

export function VerdictBadge({ verdict }) {
  const v = verdict || 'none';
  return <span className={`badge v-${v.toLowerCase()}`}><i />{verdict || 'No runs'}</span>;
}

// Small line icons per step state; colour comes from currentColor.
export function StateIcon({ state }) {
  const p = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  switch (state) {
    case 'pass': return <svg {...p}><path d="M3 8.5l3.2 3L13 4.5" /></svg>;
    case 'fail': return <svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
    case 'blocked': return <svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></svg>;
    case 'skipped': return <svg {...p}><path d="M3 8h10" strokeDasharray="2 2.4" /></svg>;
    case 'running': return <svg {...p} className="spin"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" /></svg>;
    default: return <svg {...p}><circle cx="8" cy="8" r="2.2" /></svg>;
  }
}

export const STATE_LABEL = { waiting: 'Waiting', running: 'Running', pass: 'Pass', fail: 'Fail', blocked: 'Blocked', skipped: 'Skipped' };

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

export function ErrorNote({ children }) { return <p className="note err" role="alert">{children}</p>; }
