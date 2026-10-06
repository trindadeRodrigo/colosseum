import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reader, Res } from '../data';

// A reader of Rodrigo's recording of the risk API (the snapshot his Analytics 2.0 prototype falls back
// to), for the tests: the same answers the e2e stub serves (tests/e2e/stub-risk.ts). A fixture only.

const DIR = join(
  import.meta.dirname,
  '../../../../../.design/branding/working-brand/patterns/prototypes/assets/analytics',
);
type Manifest = { captured_at: string; files: Record<string, string> };
export const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Manifest;
export const CAPTURED = Date.parse(manifest.captured_at);

export function answer<T>(path: string): Res<T> {
  const name = manifest.files[path];
  if (!name || !existsSync(join(DIR, 'snapshot', name)))
    return {
      ok: false,
      status: 404,
      body: { message: `Route GET:${path} not found` },
      reason: 'not_served',
    };
  const w = JSON.parse(readFileSync(join(DIR, 'snapshot', name), 'utf8')) as {
    status: number;
    body: T;
  };
  return w.status < 300
    ? { ok: true, status: w.status, body: w.body, reason: null }
    : { ok: false, status: w.status, body: w.body as never, reason: 'api_error' };
}

/** The paths read, in order, so a test can say which routes a page asked for. */
export function snapshotReader(): Reader & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    get: async <T>(path: string) => {
      read.push(path);
      return answer<T>(path);
    },
    probe: async () => true,
  };
}
