// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, settle, unmountAll } from '../../components/ui/test/dom';
import type { WebWalletPort } from './port';
import { fakePort } from './test/fake-port';
import { useApiFetch, WalletProvider } from './WalletProvider';

// `useApiFetch()` with the provider mounted. A call the API refuses with 401 while someone is signed
// in is sent once more with fresh tokens, and only once: a sign-in that is truly over still ends in
// the 401, which the screen turns into its sentence.

const bridge = vi.hoisted(() => ({ onPort: null as null | ((port: unknown) => void) }));
vi.mock('next/dynamic', () => ({
  default: () => (props: { onPort: (port: unknown) => void }) => {
    bridge.onPort = props.onPort;
    return null;
  },
}));

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

async function withPort(port: WebWalletPort, answers: number[]) {
  const sent: { headers: Headers; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push({ headers: new Headers(init.headers), body: init.body });
      return new Response('{}', { status: answers[sent.length - 1] ?? 200 });
    }),
  );
  const seen: { call?: ReturnType<typeof useApiFetch> } = {};
  const Screen = () => {
    seen.call = useApiFetch();
    return null;
  };
  await mount(createElement(WalletProvider, null, createElement(Screen)));
  await act(async () => bridge.onPort?.(port));
  await settle();
  const call = seen.call as ReturnType<typeof useApiFetch>;
  return { call, sent };
}

/** A signed-in port whose headers say which time they were asked for, and whether fresh. */
function signedIn() {
  const asked: ({ fresh?: boolean } | undefined)[] = [];
  const port = fakePort({
    status: 'ready',
    userId: 'did:privy:test',
    authHeaders: async (options) => {
      asked.push(options);
      return { authorization: `Bearer a${asked.length}`, 'privy-id-token': `i${asked.length}` };
    },
  });
  return { port, asked };
}

describe('a call the API refuses with 401', () => {
  it('is sent once more with fresh tokens, the same body, and that answer is returned', async () => {
    const { port, asked } = signedIn();
    const { call, sent } = await withPort(port, [401, 200]);
    const res = await act(async () =>
      call('/v1/me/chain', { method: 'PUT', body: '{"chain":"solana"}' }),
    );
    expect(res.status).toBe(200);
    expect(asked).toEqual([undefined, { fresh: true }]);
    expect(sent.map((s) => s.headers.get('privy-id-token'))).toEqual(['i1', 'i2']);
    expect(sent.map((s) => s.body)).toEqual(['{"chain":"solana"}', '{"chain":"solana"}']);
  });

  it('is sent once more only: a second 401 is the answer', async () => {
    const { port } = signedIn();
    const { call, sent } = await withPort(port, [401, 401, 200]);
    const res = await act(async () => call('/v1/me'));
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(2);
  });

  it('is not sent again for someone signed out, nor is any other refusal', async () => {
    const out = await withPort(fakePort(), [401]);
    expect((await act(async () => out.call('/v1/me'))).status).toBe(401);
    expect(out.sent).toHaveLength(1);
    await unmountAll();
    const { port } = signedIn();
    const busy = await withPort(port, [429, 200]);
    expect((await act(async () => busy.call('/v1/me'))).status).toBe(429);
    expect(busy.sent).toHaveLength(1);
  });
});
