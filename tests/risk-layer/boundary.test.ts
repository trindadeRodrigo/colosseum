import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The risk layer never imports the engine: the dependency points engine → schemas ← risk (HANDOFF-RISK §8).
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory()
      ? n === 'node_modules'
        ? []
        : files(p)
      : p.endsWith('.ts')
        ? [p]
        : [];
  });
}

describe('risk layer boundary', () => {
  it('packages/risk has no import from @colosseum/engine or packages/engine', () => {
    const offenders = files('packages/risk').filter((f) =>
      /from\s+['"](@colosseum\/engine|.*packages\/engine)/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
