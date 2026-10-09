import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The risk routes of the e2e stub (/risk/*), answered from Rodrigo's snapshot of the risk API: the
// recording his Analytics 2.0 prototype falls back to (.design/…/prototypes/assets/analytics/, captured
// 2026-10-03 against the live collectors). It is a fixture for the spec and the side-by-side screens
// only: the app never reads it, and in the app these routes come from apps/api. Every recorded answer
// is served as it was recorded, its status included; a route that was not recorded answers 404, as the
// API answers a route it does not have.

const SNAPSHOT = join(
  import.meta.dirname,
  '../../.design/branding/working-brand/patterns/prototypes/assets/analytics',
);

type Manifest = { captured_at: string; files: Record<string, string> };
let manifest: Manifest | null = null;
function load(): Manifest | null {
  if (manifest) return manifest;
  const file = join(SNAPSHOT, 'manifest.json');
  if (!existsSync(file)) return null;
  manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  return manifest;
}

/** When the snapshot was captured: the spec sets the browser's clock against it. */
export const riskCapturedAt = () => load()?.captured_at ?? null;

// Robinhood Chain, which the recording predates: fixture answers in the API's shapes
// (fixtures/risk/bearing-robinhood.json), each figure labelled `fixture`, so the page shows it with the
// MOCK plate. Only Robinhood Chain's routes are served from it; the chains side by side is not, and
// answers 404 as a route the recorded API did not have.
const ROBINHOOD = join(import.meta.dirname, '../../fixtures/risk/bearing-robinhood.json');
let robinhood: Record<string, { status: number; body: unknown }> | null = null;
const robinhoodAnswer = (path: string) => {
  robinhood ??= (JSON.parse(readFileSync(ROBINHOOD, 'utf8')) as { files: typeof robinhood }).files;
  return /chain=robinhood|\/0x[0-9a-fA-F]{40}/.test(path) ? (robinhood?.[path] ?? null) : null;
};

/** The recorded answer to a GET under /risk, or a 404 like the API's for a route it does not have. */
export function riskAnswer(pathAndQuery: string): { status: number; body: unknown } {
  const fixed = robinhoodAnswer(pathAndQuery);
  if (fixed) return fixed;
  const m = load();
  const name = m?.files[pathAndQuery];
  if (!name)
    return {
      status: 404,
      body: { message: `Route GET:${pathAndQuery} not found`, error: 'Not Found' },
    };
  const recorded = JSON.parse(readFileSync(join(SNAPSHOT, 'snapshot', name), 'utf8')) as {
    status: number;
    body: unknown;
  };
  return { status: recorded.status, body: recorded.body };
}
