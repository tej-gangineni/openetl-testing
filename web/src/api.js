import { mockApi } from './mock/mockApi.js';

export const isMock = new URLSearchParams(location.search).get('mock') === '1';
const BASE = import.meta.env.VITE_API_BASE || '/api'; // proxied to 127.0.0.1:4100 by vite

async function j(path, opts) {
  let res;
  try { res = await fetch(BASE + path, opts); }
  catch { throw new Error('Cannot reach the test server on 127.0.0.1:4100. Is it running? Add ?mock=1 to the address to try the sample run.'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

const realApi = {
  mode: 'real',
  async listScenarios() { return (await j('/scenarios')).scenarios; },
  async startRun(scenarioId) {
    return (await j('/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId }) })).runId;
  },
  async listRuns(scenarioId) { return (await j(`/runs?scenarioId=${encodeURIComponent(scenarioId)}&limit=50`)).runs; },
  async getRun(runId) { return j(`/runs/${encodeURIComponent(runId)}`); },
  // SSE: stored events replay first, then live ones; the server closes after run.end.
  subscribe(runId, onEvent, onDone, onError) {
    const es = new EventSource(`${BASE}/runs/${encodeURIComponent(runId)}/events`);
    let finished = false;
    es.onmessage = (m) => {
      let e; try { e = JSON.parse(m.data); } catch { return; }
      onEvent({ ...e, _rx: Date.now() });
      if (e.type === 'run.end') { finished = true; es.close(); onDone && onDone(); }
    };
    es.onerror = () => {
      if (finished) return;
      // EventSource would reconnect and replay from the start; reducer dedupes by seq.
      if (es.readyState === EventSource.CLOSED) onError && onError(new Error('The event stream closed before the run ended.'));
    };
    return () => { finished = true; es.close(); };
  },
};

export const api = isMock ? mockApi : realApi;
