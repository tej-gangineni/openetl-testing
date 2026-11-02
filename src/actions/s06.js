import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { globToRegex } from './fs.js';

// Total non-blank physical lines in all files of a directory matching a glob (recursive).
export async function countLines({ dir, glob = '*', recursive = true }, ctx) {
  if (!dir) throw new Error('dir is required');
  const re = globToRegex(glob);
  let files = 0, lines = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (recursive) await walk(p); }
      else if (re.test(e.name)) {
        files++;
        lines += (await readFile(p, 'utf8')).split(/\r?\n/).filter((l) => l.trim() !== '').length;
      }
    }
  };
  await walk(dir);
  ctx?.log?.(`${lines} non-blank line(s) in ${files} file(s) under ${dir}`);
  return {
    value: lines, evidence: { dir, glob, files, lines },
    io: { kind: 'fs', request: { path: dir, glob }, response: { files, lines } },
  };
}

export default { 's06.countLines': countLines };
