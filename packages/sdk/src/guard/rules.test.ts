import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { refusalOf } from '../../test/bites';
import { BASKET_ID, depositIx, OWNER, SOLANA, solanaTx, wire } from '../../test/solana';
import { BASKET_PROGRAM } from './generated/basket-program';
import { EVM_INTERFACE } from './generated/evm-interface';
import { GUARD_CHECKS } from './refusal';
import { rules } from './rules';
import { runGuard } from './run';
import type { ApprovedStep } from './types';

vi.mock('./generated/deployment-files', () => import('../../test/deployments'));

// The rules the guard is built with, read here as they are built: this file puts no other rules in
// their place. The switch the tests use to take a check out lives in test/rules.ts, which nothing the
// package builds can reach.

const step: ApprovedStep = {
  legId: 'leg-1',
  chain: 'solana',
  owner: OWNER,
  basketId: BASKET_ID,
  kind: 'deposit',
  amountRaw: '1000000000',
  trades: [],
};

describe('the rules the guard is built with', () => {
  it('refuse on every check, read the generated interfaces, and cannot be changed', () => {
    for (const check of GUARD_CHECKS)
      expect(refusalOf(() => rules.need('leg-1')(check, false, 'no'))?.code).toBe(check);
    expect(rules.program).toBe(BASKET_PROGRAM);
    expect(rules.evmInterface).toBe(EVM_INTERFACE);
    expect(Object.isFrozen(rules)).toBe(true);
    expect(() => {
      (rules as { program: unknown }).program = {};
    }).toThrow();
  });

  it('take nothing from a caller: what is handed beside the step is not read', async () => {
    const tx = solanaTx(step, wire([await depositIx(BASKET_PROGRAM, '1')]));
    const loose = runGuard as (...args: unknown[]) => unknown;
    const refusal = refusalOf(() =>
      loose(
        { step, tx, deployment: SOLANA },
        { without: [...GUARD_CHECKS], program: { ...BASKET_PROGRAM, instructions: {} } },
      ),
    );
    expect(refusal?.code).toBe('amount');
  });

  it('nothing the package builds imports from its tests', () => {
    const src = join(import.meta.dirname, '..');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(20);
    for (const file of files)
      expect(readFileSync(join(src, file), 'utf8'), file).not.toMatch(/from '(?:\.\.\/)+test\//);
  });
});
