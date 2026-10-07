// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, unmountAll } from '../../components/ui/test/dom';
import { SOLANA } from '../wallet/test/fake-port';
import { useVaultNow, VAULT_READ_WAIT_MS } from './chain-vault';

// The vault as this app's own node says it stands (`useVaultNow`), which the offer to finish a
// stopped buy waits for. A read that fails, answers something that is no vault, or never answers ends
// as `unknown`, never as `reading`: on `reading` the offer is not shown, and it must not stay hidden.

const node = vi.hoisted(() => ({
  rpc: (async () => null) as (method: string, params: unknown[]) => Promise<unknown>,
  asked: 0,
}));
vi.mock('../order/chain-node', () => ({
  chainNode: (chain: string) =>
    chain === 'solana'
      ? (method: string, params: unknown[]) => {
          node.asked += 1;
          return node.rpc(method, params);
        }
      : undefined,
}));

const AT = { owner: SOLANA, basketId: '7' };
const Probe = ({ chain = 'solana' as const, mock = false, at = AT as typeof AT | null }) => {
  const now = useVaultNow(chain, mock, at);
  return createElement('p', { 'data-state': now.state });
};
const state = (host: HTMLElement) => find(host, 'p').getAttribute('data-state');
const later = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  node.asked = 0;
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

describe('the vault as this app’s node says it stands', () => {
  it.each([
    [
      'the node cannot be reached',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
    ['the node answers nothing', async () => null],
    ['the node answers something that is no account', async () => ({ value: 'not an account' })],
    [
      'the node answers an account that is no vault',
      async () => ({ value: { owner: SOLANA, data: ['AAAA', 'base64'] } }),
    ],
    ['the chain has no such vault', async () => ({ value: null })],
  ])('is unknown, not still being read, when %s', async (_, rpc) => {
    node.rpc = rpc;
    const host = await mount(createElement(Probe));
    await later(0);
    expect(node.asked).toBeGreaterThan(0);
    expect(state(host)).toBe('unknown');
  });

  it('is unknown once its wait is over when the node never answers, and a late answer changes nothing', async () => {
    let answer: (value: unknown) => void = () => {};
    node.rpc = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const host = await mount(createElement(Probe));
    await later(VAULT_READ_WAIT_MS - 1);
    expect(state(host)).toBe('reading');
    await later(1);
    expect(state(host)).toBe('unknown');
    await act(async () => answer({ value: null }));
    await later(0);
    expect(state(host)).toBe('unknown');
  });

  it('asks no node on the mock, on a chain with none, or before it is told which vault', async () => {
    node.rpc = async () => ({ value: null });
    const mock = await mount(createElement(Probe, { mock: true }));
    await later(0);
    expect(state(mock)).toBe('unknown');
    const waiting = await mount(createElement(Probe, { at: null }));
    await later(VAULT_READ_WAIT_MS);
    expect(state(waiting)).toBe('reading');
    expect(node.asked).toBe(0);
  });
});
