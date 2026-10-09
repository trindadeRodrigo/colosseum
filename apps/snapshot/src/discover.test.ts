import { describe, expect, it } from 'vitest';
import { DISCOVERY_EVERY_MS, newChainState, ownersDue, startDiscovery } from './discover';

// When an owner is asked for their vaults: every owner at the first pass and once an hour, and in
// between only an owner the worker has not asked before.

const T = Date.UTC(2026, 9, 6, 12);
const at = (ms: number) => new Date(T + ms);

describe('owner discovery', () => {
  it('asks every owner at the first pass', () => {
    const state = newChainState();
    expect(ownersDue(state, ['a', 'b'], at(0))).toEqual({ all: true, due: ['a', 'b'] });
  });

  it('asks nobody again inside the hour, and an owner new to the worker at once', () => {
    const state = newChainState();
    startDiscovery(state, at(0));
    state.owners.add('a').add('b');
    expect(ownersDue(state, ['a', 'b'], at(600_000))).toEqual({ all: false, due: [] });
    expect(ownersDue(state, ['a', 'b', 'c'], at(600_000))).toEqual({ all: false, due: ['c'] });
    // One millisecond short of the hour is still inside it.
    expect(ownersDue(state, ['a', 'b'], at(DISCOVERY_EVERY_MS - 1)).all).toBe(false);
  });

  it('asks every owner again once the hour has passed, counted from the last time all were asked', () => {
    const state = newChainState();
    startDiscovery(state, at(0));
    state.owners.add('a');
    expect(ownersDue(state, ['a', 'b'], at(DISCOVERY_EVERY_MS))).toEqual({
      all: true,
      due: ['a', 'b'],
    });
    startDiscovery(state, at(DISCOVERY_EVERY_MS));
    expect(ownersDue(state, ['a'], at(DISCOVERY_EVERY_MS + 600_000)).all).toBe(false);
  });

  it('lets an address that had no vault be asked again when every owner is', () => {
    const state = newChainState();
    startDiscovery(state, at(0));
    state.empty.add('no-vault-here');
    startDiscovery(state, at(DISCOVERY_EVERY_MS));
    expect([...state.empty]).toEqual([]);
    expect(state.discoveredAt).toBe(T + DISCOVERY_EVERY_MS);
  });
});
