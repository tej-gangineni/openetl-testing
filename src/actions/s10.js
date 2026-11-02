// S10 data-quality actions for log pipelines: scan source log files and an Elasticsearch index with the same rules.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { HOSTS, request } from './http.js';
import { capIo, table } from './io.js';
import { checkIndex } from './es.js';

const LINE_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[,.]\d+)?)\s+([A-Z]+)\s+(\S.*)$/;
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

function newStats() {
  return { lines: 0, wellFormed: 0, malformed: 0, frames: 0, levels: {}, badLevels: 0 };
}
const FRAME_RE = /\bat [\w.$]+\([^)]*\)/g;
// Returns how many well-formed entries the text holds.
function addText(st, text) {
  st.frames += (String(text ?? '').match(FRAME_RE) || []).length;
  const before = st.wellFormed;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    st.lines++;
    const m = LINE_RE.exec(line);
    if (!m) { st.malformed++; continue; }
    st.wellFormed++;
    st.levels[m[2]] = (st.levels[m[2]] || 0) + 1;
    if (!LEVELS.includes(m[2])) st.badLevels++;
  }
  return st.wellFormed - before;
}
function finish(st) {
  const share = (k) => (st.wellFormed ? Number(((st.levels[k] || 0) / st.wellFormed).toFixed(4)) : 0);
  return { ...st, infoShare: share('INFO'), errorShare: Number((share('ERROR') + share('FATAL')).toFixed(4)) };
}
function levelTable(st) {
  return table(['level', 'lines'], Object.entries(st.levels).sort((a, b) => b[1] - a[1]));
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.log')) out.push(p);
  }
  return out;
}

// args: { dir } -> stats over every *.log file below dir
export async function sourceLogStats({ dir }, ctx) {
  const files = await walk(dir);
  const st = newStats();
  for (const f of files) addText(st, await readFile(f, 'utf8'));
  const v = { files: files.length, ...finish(st) };
  ctx?.log?.(`${files.length} files, ${v.lines} non-blank lines, ${v.wellFormed} well-formed, ${v.malformed} malformed`);
  return {
    value: v, evidence: { files: v.files, lines: v.lines, wellFormed: v.wellFormed, malformed: v.malformed, frames: v.frames, levels: v.levels },
    io: capIo({ kind: 'fs', request: { path: dir, glob: '**/*.log' }, response: levelTable(v) }),
  };
}

// args: { index } -> scrolls the whole index and applies the same line rules to each document's text
export async function indexLogStats({ index }, ctx) {
  checkIndex(index);
  await request('POST', `${HOSTS.elasticsearch}/${index}/_refresh`, { signal: ctx?.signal });
  const st = newStats();
  let docs = 0, noEntryDocs = 0, emptyDocs = 0, noFile = 0, noId = 0;
  const files = new Set();
  const post = async (url, body) => {
    const r = await request('POST', `${HOSTS.elasticsearch}${url}`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctx?.signal, timeoutMs: 120000 });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`Elasticsearch error ${r.status}: ${r.text.slice(0, 300)}`);
    return JSON.parse(r.text);
  };
  let page = await post(`/${index}/_search?scroll=2m`, { size: 1000, _source: ['text', 'source_filename', 'id'], sort: ['_doc'] });
  if (!page) return { value: { exists: false, docs: 0, files: 0, lines: 0, wellFormed: 0, malformed: 0, levels: {}, emptyDocs: 0, noEntryDocs: 0, frames: 0, noFile: 0, noId: 0, badLevels: 0, infoShare: 0, errorShare: 0 }, evidence: { index, exists: false } };
  while (page.hits.hits.length) {
    for (const h of page.hits.hits) {
      docs++;
      const s = h._source || {};
      if (typeof s.text !== 'string' || !s.text.trim()) emptyDocs++; else if (addText(st, s.text) === 0) noEntryDocs++;
      if (!s.source_filename) noFile++; else files.add(s.source_filename);
      if (!s.id) noId++;
    }
    page = await post('/_search/scroll', { scroll: '2m', scroll_id: page._scroll_id });
  }
  const v = { exists: true, docs, files: files.size, emptyDocs, noEntryDocs, noFile, noId, ...finish(st) };
  ctx?.log?.(`${docs} docs, ${v.lines} lines, ${v.wellFormed} well-formed, ${v.malformed} malformed, ${emptyDocs} empty docs`);
  return {
    value: v, evidence: { index, docs, distinctFiles: v.files, emptyDocs, noEntryDocs, lines: v.lines, wellFormed: v.wellFormed, malformed: v.malformed, frames: v.frames, levels: v.levels },
    io: capIo({ kind: 'http', request: { method: 'POST', url: `${HOSTS.elasticsearch}/${index}/_search?scroll=2m`, headers: {}, body: { size: 1000, scroll: 'all pages' } }, response: levelTable(v) }),
  };
}

export default { 's10.sourceLogStats': sourceLogStats, 's10.indexLogStats': indexLogStats };
