import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scenarios/fixtures');

// Copy scenarios/fixtures/<name>/fixture-N.md to a fresh temp dir, filling {{MARKER}} and {{EIDn}}.
// Event ids are 12 digits (the attackdb filename convention): 2099 12 31 + 4 random digits, unique per run.
export async function stage({ name }, ctx) {
  if (!/^[a-z0-9_-]+$/.test(name ?? '')) throw new Error(`Invalid fixture name: ${JSON.stringify(name)}`);
  const src = path.join(FIXTURES, name);
  const files = (await readdir(src)).filter((f) => /^fixture-\d+\.md$/.test(f)).sort();
  if (!files.length) throw new Error(`No fixture-N.md files in ${src}`);
  const stamp = Date.now().toString(36);
  const marker = `${name.toUpperCase()}-${stamp}`;
  const base = 1000 + Math.floor(Math.random() * 8000);
  const dir = path.join(tmpdir(), `openetl-testing-${marker}`);
  await mkdir(dir, { recursive: true });
  const ids = {};
  for (const f of files) {
    const n = f.match(/\d+/)[0];
    const eid = `20991231${String(base + Number(n)).padStart(4, '0')}`;
    ids[`eid${n}`] = eid;
    const text = (await readFile(path.join(src, f), 'utf8')).replaceAll('{{MARKER}}', marker).replaceAll(`{{EID${n}}}`, eid);
    await writeFile(path.join(dir, `${eid}.md`), text);
  }
  ctx?.log?.(`Staged ${files.length} fixture file(s) in ${dir} with marker ${marker}`);
  const value = { dir, marker, pipeline: path.join(src, `pipeline-${name}.toml`), ...ids };
  return {
    value, evidence: value,
    io: { kind: 'fs', request: { path: dir, glob: '*.md' }, response: { count: files.length, files: Object.values(ids).map((i) => `${i}.md`) } },
  };
}
