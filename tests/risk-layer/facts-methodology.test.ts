import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACTS_METHODOLOGY } from '../../apps/api/src/facts-methodology';
import { methodologySection } from '../../scripts/risk/facts/gen-methodology';

// PLAN-ANALYTICS item 11: the methodology the API serves is §5 of the plan, word for word.
describe('facts methodology', () => {
  it('equals §5 of docs/risk/PLAN-ANALYTICS.md (run pnpm risk:facts-methodology after editing §5)', () => {
    expect(FACTS_METHODOLOGY).toBe(
      methodologySection(readFileSync('docs/risk/PLAN-ANALYTICS.md', 'utf8')),
    );
    expect(FACTS_METHODOLOGY).toContain('Liquidator margin');
  });
});
