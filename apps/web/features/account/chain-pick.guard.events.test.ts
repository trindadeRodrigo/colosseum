// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { ChainPick } from './ChainPick';
import { withAccount } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
// The pick's own check, with the button's taken away: a button that calls its handler on every click,
// whatever it is told. A choice that was not made is still never stored.
vi.mock('../../components/ui/Button', () => ({
  Button: (props: { onClick?: () => void; children?: ReactNode; pressed?: boolean }) =>
    createElement(
      'button',
      { type: 'button', 'data-naive': '', 'aria-pressed': props.pressed, onClick: props.onClick },
      props.children,
    ),
}));

const calls: Array<{ method: string; path: string }> = [];
beforeEach(() => {
  calls.length = 0;
  portStore.set(signedInPort(EMBEDDED));
  portStore.setApi(async (path, init) => {
    calls.push({ method: init?.method ?? 'GET', path });
    return json({
      userId: 'did:privy:test',
      wallets: EMBEDDED,
      chain: init?.method === 'PUT' ? 'solana' : null,
      chainSource: init?.method === 'PUT' ? 'picked' : null,
      chainOptions: init?.method === 'PUT' ? [] : ['solana', 'robinhood'],
    });
  });
});
afterEach(unmountAll);

const buttons = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>('button[data-naive]'),
];

describe('ChainPick with a button that refuses nothing', () => {
  it('stores nothing while no chain is chosen', async () => {
    const host = await mount(
      withAccount('en', createElement(ChainPick, { options: ['solana', 'robinhood'] })),
    );
    await settle();
    const [, , confirm] = buttons(host);
    await click(confirm as HTMLElement);
    await click(confirm as HTMLElement);
    await settle();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('is wired to that button: a chosen chain is stored, once', async () => {
    const host = await mount(
      withAccount('en', createElement(ChainPick, { options: ['solana', 'robinhood'] })),
    );
    await settle();
    await click(buttons(host)[0] as HTMLElement);
    await click(buttons(host)[2] as HTMLElement);
    await settle();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/v1/me/chain' },
    ]);
  });
});
