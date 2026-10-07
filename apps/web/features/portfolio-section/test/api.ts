import type { WalletAccount } from '@colosseum/schemas';
import type { ApiFetch, Person } from '../../account/person';
import { EXPOSURE_PATH, HISTORY_PATH, PLANS_PATH, REBALANCES_PATH } from '../api';
import { exposure, history, OWNER_EVM, OWNER_SOLANA, plans, rebalances } from './fixtures';

// The API as a test of the section's pages has it: a double that answers GET /v1/me and the four
// routes of the section, each with the sample answer narrowed as its query asks, unless the test
// hands its own. The wallet's doubles are the test file's own to import: nothing outside
// features/wallet/test but a test may (features/wallet/imports.test.ts), so this file takes the store
// it serves through as an argument. A page's test, whole:
//
//   import { EMBEDDED, fakePort, signedInPort } from '../wallet/test/fake-port';
//   import { portStore } from '../wallet/test/mock-provider';
//
//   vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
//   vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
//   vi.mock('next/link', () => import('../wallet/test/mock-next'));
//
//   const server = serve(portStore);              every route answers its sample
//   portStore.set(signedInPort(EMBEDDED));        a person with a wallet of each family
//   const host = await mount(inSection('en', createElement(OverviewPage)));
//   await settle();
//   server.to(PLANS_PATH)                         the calls made to that route, with their queries

/** The wallets of the tests' person: one a family, as a passkey sign-in has (`EMBEDDED` of fake-port.ts). */
export const WALLETS: WalletAccount[] = [
  { family: 'solana', address: OWNER_SOLANA, kind: 'embedded' },
  { family: 'evm', address: OWNER_EVM, kind: 'embedded' },
];

/** The person of the tests, on Solana. */
export const PERSON: Person = {
  userId: 'did:privy:test',
  wallets: WALLETS,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};

/** What the screens' API is set on: `portStore` of features/wallet/test/mock-provider.ts. */
export type ApiHost = { setApi(next: ApiFetch): void };

export type Answer = () => Response | Promise<Response>;

export type Served = {
  /** GET /v1/me. Left out: the tests' person. */
  person?: Person;
  plans?: Answer;
  exposure?: Answer;
  rebalances?: Answer;
  history?: Answer;
  /** Any other route a page calls: the orders, for a plan's activity. */
  more?: (path: string) => Response | null;
};

/** An answer of the API, as JSON. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export function serve(host: ApiHost, served: Served = {}) {
  const calls: string[] = [];
  host.setApi(async (path) => {
    calls.push(path);
    const other = served.more?.(path);
    if (other) return other;
    const url = new URL(path, 'http://api.test');
    const q = {
      chain: url.searchParams.get('chain') ?? undefined,
      address: url.searchParams.get('address') ?? undefined,
    };
    const limit = url.searchParams.get('limit');
    switch (url.pathname) {
      case '/v1/me':
        return json(served.person ?? PERSON);
      case PLANS_PATH:
        return served.plans ? served.plans() : json(plans(q));
      case EXPOSURE_PATH:
        return served.exposure ? served.exposure() : json(exposure(q));
      case REBALANCES_PATH:
        return served.rebalances
          ? served.rebalances()
          : json(rebalances({ ...q, ...(limit === null ? {} : { limit: Number(limit) }) }));
      case HISTORY_PATH:
        return served.history ? served.history() : json(history(q));
      default:
        return json({ error: 'not found' }, 404);
    }
  });
  return {
    calls,
    /** The calls made to one route, whatever their query. */
    to: (route: string) => calls.filter((c) => c === route || c.startsWith(`${route}?`)),
  };
}

/** An answer a test lets go when it chooses: for a read that is still on its way. */
export function held(): { answer: Answer; release: (res: Response) => void; asked: () => number } {
  let asked = 0;
  const waiting: Array<(res: Response) => void> = [];
  return {
    answer: () =>
      new Promise<Response>((resolve) => {
        asked += 1;
        waiting.push(resolve);
      }),
    release: (res) => waiting.shift()?.(res),
    /** How many times it was asked, whether or not it has been let go. */
    asked: () => asked,
  };
}
