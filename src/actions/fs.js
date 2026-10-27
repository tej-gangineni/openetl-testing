import { readdir } from 'node:fs/promises';
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
  return { value: names.length, evidence: { dir, glob, recursive: !!recursive, count: names.length } };
}
