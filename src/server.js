import http from 'node:http';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import actions from './actions/index.js';
import { loadScenarios, filterScenarios } from './scenarios.js';
import { createStore } from './store.js';
import { resolveLenient } from './template.js';
import { createScheduler } from './scheduler.js';

const ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);

export function createApp({ store, scheduler, getScenarios }) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const fail = (code, error) => json(code, { error });

    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api') return fail(404, 'Not found.');
      const [, a, b, c] = parts;

      if (req.method === 'GET' && a === 'health' && !b) return json(200, { ok: true });

      if (req.method === 'GET' && a === 'scenarios' && !b) {
        const list = filterScenarios(getScenarios(), {
          tag: url.searchParams.get('tag') || undefined,
          q: url.searchParams.get('q') || undefined,
        });
        return json(200, {
          scenarios: list.map((s) => ({
            id: s.id, title: s.title, summary: s.summary, flow: resolveLenient(s.flow, { lab: config.lab, repo: config.repo }), tracker_row: s.tracker_row ?? null, tags: s.tags,
            resources: s.resources, stepCount: s.steps.length, lastRun: store.lastRun(s.id),
          })),
        });
      }

      if (a === 'runs' && !b && req.method === 'POST') {
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return fail(400, 'Request body must be valid JSON.'); }
        if (typeof body.scenarioId !== 'string') return fail(400, 'scenarioId is required.');
        const scenario = getScenarios().find((s) => s.id === body.scenarioId);
        if (!scenario) return fail(404, `No scenario with id "${body.scenarioId}".`);
        return json(202, { runId: scheduler.enqueue(scenario) });
      }

      if (a === 'runs' && !b && req.method === 'GET') {
        return json(200, {
          runs: store.listRuns({
            scenarioId: url.searchParams.get('scenarioId') || undefined,
            limit: url.searchParams.get('limit') || 50,
          }),
        });
      }

      if (a === 'runs' && b && req.method === 'GET') {
        const run = store.getRun(b);
        if (!run) return fail(404, `No run with id "${b}".`);
        if (!c) return json(200, { run, events: store.getEvents(b) });
        if (c === 'events') return sse(req, res, b, store, scheduler);
      }
      return fail(404, 'Not found.');
    } catch (e) {
      if (!res.headersSent) fail(500, e.message || 'Internal error.');
      else res.end();
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 1e6) reject(new Error('Body too large.')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sse(req, res, runId, store, scheduler) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  // Subscribe and replay in the same tick: the store is synchronous, so no event can fall between.
  let unsub = () => {};
  const finish = () => { unsub(); res.end(); };
  unsub = scheduler.subscribe(runId, (ev) => { write(ev); if (ev.type === 'run.end') finish(); });
  const stored = store.getEvents(runId);
  stored.forEach(write);
  if (stored.some((e) => e.type === 'run.end') || !scheduler.isActive(runId)) return finish();
  req.on('close', unsub);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const store = createStore();
  store.closeInterrupted();
  const scheduler = createScheduler({ store, actions, config });
  const app = createApp({ store, scheduler, getScenarios: () => loadScenarios().scenarios });
  app.listen(config.port, '127.0.0.1', () => console.log(`openetl-testing on http://127.0.0.1:${config.port}`));
}
