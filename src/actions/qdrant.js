// Qdrant actions (owned by the S08 agent). Talks to the local lab Qdrant REST API with built-in fetch.
import { cut, capIo, table } from './io.js';

const BASE = 'http://127.0.0.1:6333';
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`Invalid collection name: ${JSON.stringify(name)}`);
  return name;
}

async function call(method, path, body, ctx) {
  const url = BASE + path;
  const headers = body ? { 'content-type': 'application/json' } : {};
  let res, text;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctx?.signal });
    text = await res.text();
  } catch (e) {
    throw new Error(`HTTP ${method} ${url} failed: ${e.cause?.code ?? e.message}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const io = capIo({ kind: 'http', request: { method, url, headers: {}, body: body ?? null }, response: { status: res.status, body: cut(text) } });
  return { res, json, io, text };
}

function fail(res, text) { throw new Error(`Qdrant error ${res.status}: ${text.slice(0, 300)}`); }

// Short view of a vector: length, how many entries are non-zero, and the first few values.
function vecSummary(v) {
  if (!Array.isArray(v)) return null;
  return { dim: v.length, nonZero: v.filter((x) => x !== 0).length, head: v.slice(0, 3) };
}

export async function dropCollection({ collection }, ctx) {
  checkName(collection);
  const { res, io, text } = await call('DELETE', `/collections/${collection}`, null, ctx);
  if (res.status !== 200 && res.status !== 404) fail(res, text);
  ctx?.log?.(`Deleted collection ${collection} (status ${res.status})`);
  return { value: collection, evidence: { deleted: collection, status: res.status }, io };
}

// value: { exists, size, distance, points }
export async function collectionInfo({ collection }, ctx) {
  checkName(collection);
  const { res, json, io, text } = await call('GET', `/collections/${collection}`, null, ctx);
  if (res.status === 404) return { value: { exists: false, size: null, distance: null, points: 0 }, evidence: { collection, exists: false }, io };
  if (res.status !== 200) fail(res, text);
  const r = json.result;
  const v = r.config?.params?.vectors;
  const vec = v && typeof v.size === 'number' ? v : Object.values(v ?? {})[0] ?? {};
  const value = { exists: true, size: vec.size ?? null, distance: vec.distance ?? null, points: r.points_count ?? 0, status: r.status };
  return { value, evidence: { collection, ...value }, io };
}

export async function count({ collection, filter }, ctx) {
  checkName(collection);
  const body = { exact: true, ...(filter ? { filter } : {}) };
  const { res, json, io, text } = await call('POST', `/collections/${collection}/points/count`, body, ctx);
  if (res.status === 404) return { value: 0, evidence: { collection, exists: false, count: 0 }, io };
  if (res.status !== 200) fail(res, text);
  const n = json.result.count;
  return { value: n, evidence: { collection, count: n, filtered: !!filter }, io };
}

// Up to 20 points with payload; vectors are summarised, never dumped.
export async function scroll({ collection, filter, limit = 20 }, ctx) {
  checkName(collection);
  const body = { limit: Math.min(Number(limit) || 20, 20), with_payload: true, with_vector: true, ...(filter ? { filter } : {}) };
  const { res, json, io, text } = await call('POST', `/collections/${collection}/points/scroll`, body, ctx);
  if (res.status === 404) return { value: { points: [] }, evidence: { collection, exists: false }, io };
  if (res.status !== 200) fail(res, text);
  const points = json.result.points.map((p) => ({
    id: p.id,
    source: p.payload?.source_filename ?? p.payload?.source ?? null,
    content: String(p.payload?.content ?? '').slice(0, 120),
    vector: vecSummary(p.vector),
  }));
  io.response = { status: res.status, ...table(['id', 'source', 'content', 'vector'], points.map((p) => [p.id, p.source, p.content, p.vector])) };
  capIo(io);
  return { value: { points, sources: [...new Set(points.map((p) => p.source))] }, evidence: { collection, returned: points.length }, io };
}

// Vector search. args: { collection, vector (array), limit, filter }
export async function search({ collection, vector, limit = 5, filter }, ctx) {
  checkName(collection);
  if (!Array.isArray(vector)) throw new Error('qdrant.search needs a vector array');
  const body = { vector, limit: Math.min(Number(limit) || 5, 20), with_payload: true, ...(filter ? { filter } : {}) };
  const { res, json, io, text } = await call('POST', `/collections/${collection}/points/search`, body, ctx);
  if (res.status !== 200) fail(res, text);
  const hits = json.result.map((h) => ({ id: h.id, score: h.score, source: h.payload?.source_filename ?? null, content: String(h.payload?.content ?? '').slice(0, 120) }));
  io.request.body = { ...body, vector: `[${vector.length} numbers]` };
  io.response = { status: res.status, ...table(['id', 'score', 'source', 'content'], hits.map((h) => [h.id, h.score, h.source, h.content])) };
  capIo(io);
  return { value: { hits }, evidence: { collection, returned: hits.length, topScore: hits[0]?.score ?? null }, io };
}

// Scan every point (batches of 256) and report quality stats.
// value: { points, withPayload, withContent, withSource, zeroVectors, nonZeroVectors, wrongDim, sources: [..], perSource }
export async function stats({ collection, dim }, ctx) {
  checkName(collection);
  const s = { points: 0, withPayload: 0, withContent: 0, withSource: 0, zeroVectors: 0, nonZeroVectors: 0, wrongDim: 0 };
  const per = {};
  let offset = null, last;
  do {
    const body = { limit: 256, with_payload: true, with_vector: true, ...(offset ? { offset } : {}) };
    const { res, json, io, text } = await call('POST', `/collections/${collection}/points/scroll`, body, ctx);
    last = io;
    if (res.status === 404) return { value: { ...s, sources: [], perSource: {} }, evidence: { collection, exists: false }, io };
    if (res.status !== 200) fail(res, text);
    for (const p of json.result.points) {
      s.points++;
      const pl = p.payload ?? {};
      if (Object.keys(pl).length) s.withPayload++;
      if (typeof pl.content === 'string' && pl.content.trim()) s.withContent++;
      const src = pl.source_filename || pl.source;
      if (src) { s.withSource++; per[src] = (per[src] ?? 0) + 1; }
      const v = p.vector;
      if (Array.isArray(v) && v.some((x) => x !== 0)) s.nonZeroVectors++; else s.zeroVectors++;
      if (dim && Array.isArray(v) && v.length !== dim) s.wrongDim++;
    }
    offset = json.result.next_page_offset ?? null;
  } while (offset);
  const sources = Object.keys(per).sort();
  const value = { ...s, sources, perSource: per };
  last.request.body = { note: 'scrolled all points in batches of 256', ...last.request.body };
  last.response = { status: 200, ...table(['metric', 'value'], Object.entries(s)) };
  capIo(last);
  ctx?.log?.(`Scanned ${s.points} points: ${s.nonZeroVectors} non-zero vectors, ${s.zeroVectors} zero vectors, ${sources.length} sources`);
  return { value, evidence: { collection, ...s, sourceCount: sources.length }, io: last };
}

export default {
  'qdrant.dropCollection': dropCollection,
  'qdrant.collectionInfo': collectionInfo,
  'qdrant.count': count,
  'qdrant.scroll': scroll,
  'qdrant.search': search,
  'qdrant.stats': stats,
};
