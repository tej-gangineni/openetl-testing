// Replays stored events with their original spacing (from `ts`), clamped so
// long gaps do not make the viewer wait. Returns a cancel function.
export function replay(events, onEvent, { speed = 1, maxGap = 900, minGap = 25, onDone } = {}) {
  let i = 0, timer = null, cancelled = false;
  const tick = () => {
    if (cancelled) return;
    onEvent({ ...events[i], _rx: Date.now() });
    i++;
    if (i >= events.length) { onDone && onDone(); return; }
    const gap = Date.parse(events[i].ts) - Date.parse(events[i - 1].ts);
    const wait = Math.min(maxGap, Math.max(minGap, Number.isFinite(gap) ? gap : minGap)) / speed;
    timer = setTimeout(tick, wait);
  };
  if (events.length) timer = setTimeout(tick, 150); else onDone && onDone();
  return () => { cancelled = true; clearTimeout(timer); };
}
