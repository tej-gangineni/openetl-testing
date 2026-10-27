import { HOSTS, request } from './http.js';
import { cut, capIo, table } from './io.js';

const INDEX_RE = /^[a-z0-9_][a-z0-9_.-]*$/;
export function checkIndex(name) {
  if (typeof name !== 'string' || !INDEX_RE.test(name)) throw new Error(`Invalid index name: ${JSON.stringify(name)}`);
  return name;
}

async function call(method, path, body, ctx) {
  const url = `${HOSTS.elasticsearch}${path}`;
  const res = await request(method, url, {
    headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: ctx?.signal,
  });
  const io = capIo({ kind: 'http', request: { method, url, headers: {}, body: body ?? null }, response: { status: res.status, body: cut(res.text) } });
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* not json */ }
  return { res, json, io };
}

// Make documents written a moment ago visible to search (ES refreshes once a second on its own).
async function refresh(index, ctx) {
  await request('POST', `${HOSTS.elasticsearch}/${index}/_refresh`, { signal: ctx?.signal });
}

export async function esCount({ index }, ctx) {
  checkIndex(index);
  await refresh(index, ctx);
  const { res, json, io } = await call('GET', `/${index}/_count`, null, ctx);
  if (res.status === 404) return { value: 0, evidence: { index, exists: false, count: 0 }, io };
  if (res.status !== 200) throw new Error(`Elasticsearch error ${res.status}: ${res.text.slice(0, 300)}`);
  return { value: json.count, evidence: { index, exists: true, count: json.count }, io };
}

// Read-only search. args: { index, query (ES query DSL), size, fields (_source list) }
export async function esSearch({ index, query = { match_all: {} }, size = 20, fields }, ctx) {
  checkIndex(index);
  await refresh(index, ctx);
  const body = { query, size: Math.min(Number(size) || 20, 100) };
  if (fields) body._source = fields;
  const { res, json, io } = await call('POST', `/${index}/_search`, body, ctx);
  if (res.status === 404) return { value: { total: 0, hits: [] }, evidence: { index, exists: false }, io };
  if (res.status !== 200) throw new Error(`Elasticsearch error ${res.status}: ${res.text.slice(0, 300)}`);
  const total = typeof json.hits.total === 'object' ? json.hits.total.value : json.hits.total;
  const hits = json.hits.hits.map((h) => h._source);
  const cols = fields ? [...fields] : [...new Set(hits.flatMap((h) => Object.keys(h)))].slice(0, 8);
  io.response = { status: res.status, ...table(cols, hits.map((h) => cols.map((c) => h[c]))), total };
  capIo(io);
  return { value: { total, hits }, evidence: { index, total, returned: hits.length }, io };
}

// The one write: delete an index.
export async function esDropIndex({ index }, ctx) {
  checkIndex(index);
  const { res, io } = await call('DELETE', `/${index}`, null, ctx);
  if (res.status !== 200 && res.status !== 404) throw new Error(`Elasticsearch error ${res.status}: ${res.text.slice(0, 300)}`);
  ctx?.log?.(`Deleted index ${index} (status ${res.status})`);
  return { value: index, evidence: { deleted: index, status: res.status }, io };
}

// Distinct values of a keyword field (terms aggregation, up to 500).
export async function esDistinct({ index, field }, ctx) {
  checkIndex(index);
  if (!/^[A-Za-z0-9_.]+$/.test(field ?? '')) throw new Error(`Invalid field name: ${JSON.stringify(field)}`);
  await refresh(index, ctx);
  const body = { size: 0, aggs: { d: { terms: { field, size: 500 } } } };
  const { res, json, io } = await call('POST', `/${index}/_search`, body, ctx);
  if (res.status === 404) return { value: [], evidence: { index, exists: false, distinct: 0 }, io };
  if (res.status !== 200) throw new Error(`Elasticsearch error ${res.status}: ${res.text.slice(0, 300)}`);
  const keys = json.aggregations.d.buckets.map((b) => b.key).sort();
  io.response = { status: res.status, ...table([field, 'docs'], json.aggregations.d.buckets.map((b) => [b.key, b.doc_count])) };
  capIo(io);
  return { value: keys, evidence: { index, field, distinct: keys.length }, io };
}
