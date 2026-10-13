// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, settle, unmountAll } from '../../components/ui/test/dom';
import { SIGNED_IN_COOKIE } from '../../i18n';
import { fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { withAccount } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));

// The hint the landing page reads (`/` sends a person signed in here on to /goal): set while someone is
// signed in, cleared when they sign out, and untouched while the wallet is still loading.

const hint = () =>
  document.cookie.split('; ').find((c) => c.startsWith(`${SIGNED_IN_COOKIE}=`)) ?? null;

beforeEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: the test starts from no hint
  document.cookie = `${SIGNED_IN_COOKIE}=; max-age=0; path=/`;
  portStore.setApi(async () => json({}, 503));
});
afterEach(unmountAll);

describe('the signed-in hint', () => {
  it('is set while someone is signed in, and cleared when they sign out', async () => {
    portStore.set(signedInPort(PHANTOM));
    await mount(withAccount('en', createElement('p', null, 'page')));
    await settle();
    expect(hint()).toBe(`${SIGNED_IN_COOKIE}=1`);
    await act(async () => portStore.set(fakePort()));
    await settle();
    expect(hint()).toBeNull();
  });

  it('says nothing while the wallet is still loading', async () => {
    portStore.set(fakePort({ status: 'loading' }));
    await mount(withAccount('en', createElement('p', null, 'page')));
    await settle();
    expect(hint()).toBeNull();
  });
});
