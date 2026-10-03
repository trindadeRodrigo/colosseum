import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// PLAN-ANALYTICS item 18.1 and 18.2: the hourly jobs (scripts/risk/jobs) run outside the repo with RISK_DATA_DIR
// and RISK_ISSUER_MODELS set by the env file (DA8). The split folder has one definition, which follows
// RISK_DATA_DIR, and every script that writes or reads split snapshots takes it from there.

const SPLIT_SCRIPTS = [
  'scripts/risk/split-snapshot.ts',
  'scripts/risk/facts/cost-breakdown.ts',
  'scripts/risk/facts/freeze-split-fixture.ts',
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('split folder (18.1)', () => {
  it('defaults to data/risk/split, unchanged for hand runs', async () => {
    vi.stubEnv('RISK_DATA_DIR', undefined);
    vi.resetModules();
    const lib = await import('../../scripts/risk/lib-lending');
    expect(lib.SPLIT_DIR).toBe(join('data/risk', 'split'));
    expect(lib.LENDING_HISTORY_DIR).toBe(join('data/risk', 'lending-history'));
  });

  it('follows RISK_DATA_DIR when the module is read with it set', async () => {
    vi.stubEnv('RISK_DATA_DIR', '/tmp/colosseum-job-data');
    vi.resetModules();
    const lib = await import('../../scripts/risk/lib-lending');
    expect(lib.SPLIT_DIR).toBe('/tmp/colosseum-job-data/split');
    expect(lib.LENDING_HISTORY_DIR).toBe('/tmp/colosseum-job-data/lending-history');
  });

  it.each(SPLIT_SCRIPTS)('%s takes the folder from SPLIT_DIR and hard-codes none', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/import \{[^}]*\bSPLIT_DIR\b[^}]*\} from '\.\.?\/(\.\.\/)?lib-lending'/);
    expect(src).not.toMatch(/['`]data\/risk\/split/);
    expect(src).not.toMatch(/join\(LENDING_DATA, 'split'\)/);
  });
});

describe('issuer models (18.2)', () => {
  it('the lending report reads them from RISK_ISSUER_MODELS, with the fixture as default', () => {
    const src = readFileSync('scripts/risk/lending-report.ts', 'utf8');
    expect(src).toContain("process.env.RISK_ISSUER_MODELS ?? 'fixtures/risk/issuer-models.json'");
    expect(src).not.toContain("readFileSync('fixtures/risk/issuer-models.json'");
  });
});
