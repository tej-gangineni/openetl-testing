import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

export async function countFiles({ dir, glob = '*', recursive = false }, ctx) {
  if (!dir) throw new Error('dir is required');
  const re = globToRegex(glob);
  const entries = await readdir(dir, { withFileTypes: true, recursive: !!recursive });
  const names = entries.filter((e) => e.isFile() && re.test(e.name)).map((e) => path.join(e.parentPath ?? dir, e.name));
  ctx?.log?.(`${names.length} file(s) matching ${glob} in ${dir}${recursive ? ' (recursive)' : ''}`);
  return {
    value: names.length, evidence: { dir, glob, recursive: !!recursive, count: names.length },
    io: { kind: 'fs', request: { path: dir, glob }, response: { count: names.length, files: names.slice(0, 20).map((n) => path.basename(n)), truncated: names.length > 20 } },
  };
}

// Sorted names of the files matching the glob.
export async function listFiles({ dir, glob = '*', recursive = false }, ctx) {
  if (!dir) throw new Error('dir is required');
  const re = globToRegex(glob);
  const entries = await readdir(dir, { withFileTypes: true, recursive: !!recursive });
  const names = entries.filter((e) => e.isFile() && re.test(e.name)).map((e) => e.name).sort();
  ctx?.log?.(`${names.length} file(s) matching ${glob} in ${dir}`);
  return {
    value: names, evidence: { dir, glob, count: names.length },
    io: { kind: 'fs', request: { path: dir, glob }, response: { count: names.length, files: names.slice(0, 20), truncated: names.length > 20 } },
  };
}

// Data rows of a CSV file (physical lines minus the header). Fine for simple CSVs without embedded newlines.
export async function countCsvRows({ file }, ctx) {
  if (!file) throw new Error('file is required');
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l !== '');
  const n = Math.max(0, lines.length - 1);
  ctx?.log?.(`${n} data row(s) in ${file}`);
  return {
    value: n, evidence: { file, dataRows: n, header: lines[0]?.slice(0, 200) },
    io: { kind: 'fs', request: { path: file, glob: '' }, response: { dataRows: n, header: lines[0]?.slice(0, 200) } },
  };
}
