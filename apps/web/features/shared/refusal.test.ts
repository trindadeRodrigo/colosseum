import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { sharedRefusal } from './refusal';

// What a shared portfolio's screens say of a refusal, from the one place. Our server always sends a
// sentence with its code: the code is what is read.

const en = dictionary('en');
const said = (error: string, code?: string) =>
  ({ kind: 'said', status: 409, error, fix: null, ...(code ? { code } : {}) }) as never;

describe('a refusal of a shared portfolio’s buy or follow', () => {
  it('a new version: the portfolio’s own sentence, never the plan’s', () => {
    for (const placed of [said('x', 'VERSION_CHANGED'), { kind: 'code', code: 'VERSION_CHANGED' }])
      expect(sharedRefusal(placed as never, en)).toEqual({
        sentence: en.shared.refusal.versionChanged,
        changed: true,
      });
    expect(en.shared.refusal.versionChanged).not.toContain('plan');
  });

  it('an asset that cannot be bought: named where our server names it, and said without a name where it does not', () => {
    expect(
      sharedRefusal(said('solana:spyx cannot be bought on Solana', 'ASSET_NOT_ELIGIBLE'), en),
    ).toEqual({ sentence: en.shared.refusal.assetNamed('SPYx'), changed: false });
    for (const placed of [
      said('the price feed is down', 'ASSET_NOT_ELIGIBLE'),
      { kind: 'code', code: 'ASSET_NOT_ELIGIBLE' },
    ])
      expect(sharedRefusal(placed as never, en)?.sentence).toBe(en.shared.refusal.asset);
  });

  it('what is the same for any buy keeps the buy’s sentence, and a refusal with no code keeps our server’s', () => {
    expect(sharedRefusal(said('x', 'NOT_FUNDED'), en)?.sentence).toBe(en.buy.failure.NOT_FUNDED);
    expect(sharedRefusal(said('the creator reached their limit'), en)).toBeNull();
  });
});
