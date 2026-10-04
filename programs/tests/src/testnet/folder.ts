import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { REPO_ROOT } from '../env';

/** The real path of `path`, resolved from the working directory and through links, as far as it exists. */
function real(path: string): string {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  const parent = dirname(full);
  return parent === full ? full : resolve(real(parent), relative(parent, full));
}

/** Whether a folder is the repository or inside it: a relative path, `..` and links counted. */
export function insideRepo(path: string): boolean {
  const from = relative(real(REPO_ROOT), real(path));
  return from === '' || !(from === '..' || from.startsWith('../') || isAbsolute(from));
}
