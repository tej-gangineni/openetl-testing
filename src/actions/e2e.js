// Helpers for the E-series API scenarios: isolated inputs and outputs under <lab>/state/e2e,
// a small harness-hosted web site with unique content, and JSONL output checks.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { globToRegex } from './fs.js';

function e2eRoot(ctx) {
  const lab = ctx?.vars?.lab ?? ctx?.config?.lab;
  if (!lab) throw new Error('lab path is not known');
  return path.join(lab, 'state', 'e2e');
}

// Only paths strictly inside <lab>/state/e2e may be written or removed.
export function insideE2e(p, root) {
  const abs = path.resolve(p);
  return abs.startsWith(path.resolve(root) + path.sep);
}

function stamp() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

// Add a unique marker so the content is new to any store that de-duplicates by content hash.
export function markContent(name, text, marker) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    const p = `<p>E2E run marker ${marker} for ${name}.</p>`;
    return /<body[^>]*>/i.test(text) ? text.replace(/<body([^>]*)>/i, `<body$1>${p}`) : p + text;
  }
  if (ext === '.json') {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify({ ...v, e2e_marker: marker }, null, 2);
    } catch { /* fall through to text */ }
  }
  return `${text.replace(/\s*$/, '')}\n\nE2E run marker ${marker} for ${name}.\n`;
}

// Copy files from a lab folder into a fresh state/e2e/<name>-<stamp> folder, each with a run marker.
export async function copyMarked({ from, glob = '*', limit, files, name, mark = true }, ctx) {
  if (!/^[a-z0-9_-]+$/i.test(name ?? '')) throw new Error(`Invalid fixture name: ${JSON.stringify(name)}`);
  const re = globToRegex(glob);
  let pick = files ?? (await readdir(from)).filter((f) => re.test(f)).sort();
  if (limit) pick = pick.slice(0, Number(limit));
  if (!pick.length) throw new Error(`No files matching ${glob} in ${from}`);
  const marker = `E2E-${name.toUpperCase()}-${stamp()}`;
  const dir = path.join(e2eRoot(ctx), `${name}-${stamp()}`);
  await mkdir(dir, { recursive: true });
  for (const f of pick) {
    const text = await readFile(path.join(from, f), 'utf8');
    await writeFile(path.join(dir, f), mark ? markContent(f, text, marker) : text);
  }
  ctx?.log?.(`Copied ${pick.length} file(s) from ${from} to ${dir} with marker ${marker}`);
  const value = { dir, marker, files: pick, count: pick.length };
  return { value, evidence: value, io: { kind: 'fs', request: { path: dir, glob }, response: { count: pick.length, files: pick.slice(0, 20), marker } } };
}

// A fresh output folder state/e2e/<name>-<stamp>; returns { dir, file } (file = dir/out.jsonl, not created).
export async function outDir({ name }, ctx) {
  if (!/^[a-z0-9_-]+$/i.test(name ?? '')) throw new Error(`Invalid name: ${JSON.stringify(name)}`);
  const dir = path.join(e2eRoot(ctx), `${name}-${stamp()}`);
  await mkdir(dir, { recursive: true });
  const value = { dir, file: path.join(dir, 'out.jsonl'), file2: path.join(dir, 'out2.jsonl') };
  ctx?.log?.(`Output folder ${dir}`);
  return { value, evidence: value, io: { kind: 'fs', request: { path: dir, glob: '' }, response: { created: dir } } };
}

export async function removeE2e({ path: p }, ctx) {
  const root = e2eRoot(ctx);
  if (!p || !insideE2e(p, root)) throw new Error(`Refusing to remove ${p}: only paths inside ${root} may be removed`);
  await rm(p, { recursive: true, force: true });
  ctx?.log?.(`Removed ${p}`);
  return { value: p, evidence: { removed: p }, io: { kind: 'fs', request: { path: p, glob: '' }, response: { removed: true } } };
}

export async function exists({ path: p }, ctx) {
  let info = null;
  try { info = await stat(p); } catch { /* absent */ }
  const value = !!info;
  ctx?.log?.(`${p} ${value ? 'exists' : 'does not exist'}`);
  return { value, evidence: { path: p, exists: value }, io: { kind: 'fs', request: { path: p, glob: '' }, response: { exists: value, isDir: info?.isDirectory() ?? null } } };
}

// Lines, valid JSON objects, distinct values of `field`, how many lines mention `contains`, and a sample.
export async function jsonlStats({ file, field = 'source_filename', contains }, ctx) {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  let valid = 0;
  const distinct = new Set();
  const keys = new Set();
  let withText = 0;
  let mentions = 0;
  const sample = [];
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    valid++;
    Object.keys(o).forEach((k) => keys.add(k));
    if (o[field] !== undefined && o[field] !== null) distinct.add(String(o[field]));
    if (typeof o.text === 'string' && o.text.trim()) withText++;
    if (contains && l.includes(contains)) mentions++;
    if (sample.length < 3) sample.push({ [field]: o[field] ?? null, element_type: o.element_type ?? null, text: String(o.text ?? '').slice(0, 100) });
  }
  const value = { exists: text !== '' || lines.length > 0, lines: lines.length, valid, invalid: lines.length - valid, withText, distinct: distinct.size, distinctValues: [...distinct].sort().slice(0, 50), keys: [...keys].sort(), mentions };
  ctx?.log?.(`${file}: ${lines.length} line(s), ${valid} valid, ${distinct.size} distinct ${field}`);
  return {
    value, evidence: { file, lines: value.lines, valid, distinct: distinct.size, field, mentions },
    io: { kind: 'fs', request: { path: file, glob: '' }, response: { lines: value.lines, valid, invalid: value.invalid, distinct: distinct.size, field, keys: value.keys.slice(0, 30), sample } },
  };
}

// ---------- a small web site served by the test harness (unique content per run) ----------

const SERVERS = new Map();

export function buildSite({ base, marker, pages, paragraphs, per = 15 }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const files = {};
  const titles = [];
  for (let i = 1; i <= pages; i++) {
    const title = `E2E page ${i} ${marker}`;
    titles.push(title);
    const body = paragraphs.slice((i - 1) * per, i * per).map((p) => `<p>${esc(p)}</p>`).join('\n');
    files[`/pages/p${i}.html`] = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1>\n<p>E2E run marker ${marker} on page ${i}.</p>\n${body}\n</article></body></html>`;
  }
  const links = titles.map((t, i) => `<li><a href="pages/p${i + 1}.html">${t}</a></li>`).join('');
  files['/'] = files['/index.html'] = `<!doctype html><html><head><meta charset="utf-8"><title>E2E site ${marker}</title></head><body><h1>E2E site ${marker}</h1><ul>${links}</ul></body></html>`;
  const items = titles.map((t, i) => `<item><title>${t}</title><link>${base}/pages/p${i + 1}.html</link><guid>${marker}-${i + 1}</guid><pubDate>Mon, 02 Nov 2026 09:0${i}:00 GMT</pubDate><description>Item ${i + 1} of ${marker}</description></item>`).join('\n');
  files['/feed.xml'] = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>E2E feed ${marker}</title><link>${base}/</link><description>E2E feed</description>\n${items}\n</channel></rss>`;
  return files;
}

// Start a local site on 127.0.0.1 (free port): /, /index.html, /feed.xml, /pages/p1..pN.html.
// Paragraph text is taken from a lab text file so the extractor has real prose to chunk.
export async function webStart({ pages = 3, textFrom, name = 'web' }, ctx) {
  if (!textFrom) throw new Error('textFrom (a lab text file) is required');
  const raw = await readFile(textFrom, 'utf8');
  const paragraphs = raw.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 120 && p.length < 1500).slice(0, pages * 15);
  const marker = `E2E-${String(name).toUpperCase()}-${stamp()}`;
  const hits = [];
  let files = {};
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    hits.push(url);
    const body = files[url];
    if (body === undefined) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': url.endsWith('.xml') ? 'application/rss+xml; charset=utf-8' : 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  files = buildSite({ base, marker, pages, paragraphs });
  SERVERS.set(base, { server, hits });
  ctx?.log?.(`Serving ${pages} page(s), a feed and an index at ${base} with marker ${marker}`);
  const value = { base, marker, pages, index: `${base}/`, feed: `${base}/feed.xml`, page1: `${base}/pages/p1.html` };
  return { value, evidence: value, io: { kind: 'http', request: { method: 'LISTEN', url: base }, response: { status: 200, body: Object.keys(files).join(', ') } } };
}

export async function webStop({ base }, ctx) {
  const s = SERVERS.get(base);
  if (!s) { ctx?.log?.(`No harness site at ${base}`); return { value: 0, evidence: { base, running: false } }; }
  await new Promise((resolve) => { s.server.close(() => resolve()); s.server.closeAllConnections?.(); });
  SERVERS.delete(base);
  ctx?.log?.(`Stopped ${base} after ${s.hits.length} request(s)`);
  return { value: s.hits.length, evidence: { base, requests: s.hits.length, paths: [...new Set(s.hits)].slice(0, 20) }, io: { kind: 'http', request: { method: 'CLOSE', url: base }, response: { status: 200, body: `${s.hits.length} request(s): ${[...new Set(s.hits)].join(', ')}`.slice(0, 2000) } } };
}

// The `field` of every object in `list` (arrays are flattened), e.g. all connector ids and schemes.
export async function pluck({ list, field, fields }, ctx) {
  if (!Array.isArray(list)) throw new Error(`pluck needs a list, got ${JSON.stringify(list)?.slice(0, 100)}`);
  const names = fields ?? [field];
  const out = [...new Set(list.flatMap((o) => names.flatMap((f) => [o?.[f]].flat())).filter((x) => x !== undefined && x !== null))];
  ctx?.log?.(`${out.length} value(s) of ${names.join(', ')}: ${out.slice(0, 60).join(', ')}`);
  return { value: out, evidence: { count: out.length, values: out.slice(0, 60) }, io: { kind: 'compare', request: { left: `${list.length} objects`, op: 'pluck', right: names.join(', ') }, response: { values: out.slice(0, 80) } } };
}

export default {
  'data.pluck': pluck,
  'fixture.copyMarked': copyMarked,
  'fixture.outDir': outDir,
  'fixture.webStart': webStart,
  'fixture.webStop': webStop,
  'fs.removeE2e': removeE2e,
  'fs.exists': exists,
  'fs.jsonlStats': jsonlStats,
};
