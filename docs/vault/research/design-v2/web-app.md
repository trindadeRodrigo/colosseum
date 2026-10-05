# Web app: design v2 note

Oct 1, 2026. Stream: `apps/web`. Built on the audit reviewers' notes (outside this repo; summary in `docs/vault/AUDIT-VAULT.md`) (the `web-NN` findings) and `apps/web` on `risk-layer`. `[n]` = checked today against source n. `[memory]` = not checked.

## 1. Bottom line

- Keep the stack. Next 16.3.8, React 19.3.0 and Tailwind 4.3.3 are the current releases [1]. Add Privy, viem, TanStack Query, next-intl, Playwright. Remove wallet-adapter and web3.js 1.x.
- The browser never imports a chain adapter and never holds an RPC URL. It gets unsigned transactions from the API as bytes, signs through one `WalletPort`, and reports back. This also avoids a version clash: Privy needs `@solana/kit` 3.0.3 or newer, `packages/chain-solana` is on 2.3.0 [1].
- Every buy, rebalance, withdraw and publish is an **order** made of **legs**, stored by the API and shown at `/orders/[id]`. A reload resumes it. The agent approval link is the same page.
- Freeze five shared things on day 1: `WalletPort`, the order and leg types, the SDK client, UI primitives on semantic tokens, and the message files. After that each screen is one folder and one agent, built against the mock adapter.
- Two things need a person now: people in the US would hit the US block, and passkeys bind to a domain that has not been chosen.

## 2. What to use for the MVP

### Versions

| Package | Version | Note |
|---|---|---|
| next, react, tailwindcss | 16.3.8, 19.3.0, 4.3.3 | In the repo, already latest [1] |
| @privy-io/react-auth | 3.46.0 | Peer: `@solana/kit >=3.0.3`, React 18 or 19 [1]. No extra config under Turbopack [2] |
| viem | 2.57.x | Without wagmi: `@privy-io/wagmi` 4.0.17 pins viem to exactly 2.56.0 and adds a provider layer [1][4] |
| @tanstack/react-query | 5.104 | Per-wallet data, order polling [1] |
| next-intl | 4.14.8 | Supports Next 16 [1][7] |
| shadcn CLI | 4.21.1 | Copies accessible primitives into `components/ui`; has `--monorepo` [1][9] |
| @playwright/test, @axe-core/playwright | 1.63, 4.13 | [1] |

Remove from `apps/web`: `@solana/wallet-adapter-*`, `@solana/web3.js`.

### Server and client components, caching, forms

- **Same for everyone** (shelf, index page, risk sheet): server components, fetched with `fetch(..., { next: { revalidate: 60, tags } })` in a child under `<Suspense>`. Add `loading.tsx`, `error.tsx` and `notFound()`; none exist today (web-06).
- **Per wallet** (portfolio, vaults, orders, holdings, quotes): client components with TanStack Query. The server has no session. Every query key includes owner address and chain, which fixes the stale-wallet bug (web-03).
- **Leave `cacheComponents` off.** It is opt-in in 16.3 [5]. Rodrigo's risk pages export `dynamic = 'force-dynamic'`, which the new model removes, and next-intl needs extra setup inside it [8]. New pages carry no `dynamic` export, so turning it on later is additive. With it off, `fetch` is uncached unless asked [6].
- **Forms:** real `<form>` elements with React 19 `useActionState`, validated by the zod schemas in `@colosseum/schemas`; options generated from the schema enums (web-10, web-11).
- **No Server Functions for writes.** The Fastify API is the one backend and agents use the same endpoints. The browser calls `/api/*`, which a Next rewrite sends to the API host: no CORS, no API URL in the bundle (web-16), one place for the geo check.

### Wallet: one interface (freeze day 1)

```ts
// apps/web/lib/wallet/port.ts
type Family = 'solana' | 'evm';
interface WalletPort {
  status: 'loading' | 'signed-out' | 'ready';
  accounts: Partial<Record<Family, string>>;   // the vault owner on each family
  kind: 'embedded' | 'external';               // embedded = passkey wallet
  signIn(method: 'passkey' | 'wallet'): Promise<void>;
  signOut(): Promise<void>;
  submit(tx: UnsignedTx): Promise<{ txId: string }>;  // sign and broadcast one transaction
}
// submit throws WalletError { code: 'rejected' | 'expired' | 'no_gas' | 'wrong_chain' | 'unknown' }
```

- `UnsignedTx` is Rodrigo's schema in `packages/schemas/src/tx.ts` (base64 bytes for Solana; `to`, `value`, `chainId` and calldata for EVM; `executionId`; `lastValidBlockHeight`). Extend it.
- `PrivyWallet`: on Solana, `useSignTransaction` from `@privy-io/react-auth/solana` takes and returns a `Uint8Array` [3]; the web posts the signed bytes and the API broadcasts. On EVM, `wallet.getEthereumProvider()` and `wallet.switchChain(id)`, then a viem wallet client with `custom(provider)` sends [4]. Chain 4663 is a viem `defineChain`.
- For the passkey wallet, `uiOptions.showWalletUIs: false` signs legs without a prompt each [3]. That is what makes "one tap" literal. External wallets prompt at least once per EVM transaction.
- `TestWallet`: same interface, local keys, selected by `NEXT_PUBLIC_WALLET_MODE=test`, excluded from production builds.

### Orders and legs (freeze day 1)

```ts
type LegStatus = 'planned' | 'building' | 'awaiting_signature' | 'submitted'
               | 'confirmed' | 'failed' | 'expired' | 'skipped';
type Leg = { id: string; chain: ChainId; seq: number; dependsOn: string[];
  kind: 'create_vault' | 'approve' | 'deposit' | 'swap' | 'withdraw' | 'set_auto_follow' | 'publish';
  description: string; status: LegStatus; txId?: string; explorerUrl?: string;
  error?: { code: string; message: string; retryable: boolean }; provenance: 'live' | 'mock' };
type Order = { id: string; kind: 'buy' | 'rebalance' | 'withdraw' | 'publish' | 'settings';
  owner: Partial<Record<Family, string>>; legs: Leg[]; fees: FeeLine[]; createdAt: string };
```

The web needs four endpoints from the backend stream: `POST /orders` (plan legs, build nothing), `POST /orders/:id/legs/:legId/build` (a fresh `UnsignedTx`), `POST .../report` (a txId, or signed Solana bytes to broadcast), `GET /orders/:id` (the server calls the adapter's `track`). `Leg` maps onto Rodrigo's `executions` table.

Executor rules (`lib/order/`):

- Chains run in parallel; legs on one chain run in order.
- Build each leg just before signing. A Solana blockhash lasts about a minute [memory], and the audit found legs expiring while the user approved earlier ones (web-09).
- Write every transition to the API before the next step. On reload: `submitted` legs are tracked; `awaiting_signature` and `expired` legs are rebuilt; signed bytes are never re-sent.
- A failed leg stops its chain only. Retry is a tap, never automatic (Rodrigo's rule). Status changes go to an `aria-live` region with the explorer link.

### Screens, one folder each

Shared, built first by one agent: `app/layout.tsx`, `app/providers.tsx`, `proxy.ts`, `components/ui/`, `lib/{wallet,order,sdk,chains,format,brand}`, `styles/tokens.css`, `messages/`.

| `apps/web/features/` | Route | Kind | Starts from |
|---|---|---|---|
| `shelf` | `/` | server | new |
| `index` (with risk roll-up) | `/indexes/[slug]` | server | `PlanView` table, `/risk/[asset]` charts |
| `fit` | `/fit`, `/fit/[slug]` | client form | `GoalFlow` |
| `basket` (card, drift, rebalance, settings) | `/baskets/[id]` | mixed | `ScheduleChart`, monitor drift table |
| `order` (buy, rebalance, withdraw, approval) | `/orders/[id]` | client | signing loop in `monitor/page.tsx` |
| `portfolio` | `/portfolio` | client | monitor |
| `publish` | `/publish` | client | new |
| `blocked`, notices | `/blocked` | server | `DISCLAIMER` pattern |

Each folder holds its components, `queries.ts`, fixtures, its message namespace and one Playwright spec. An agent edits only its folder and route file. Rodrigo's `/risk/*` pages stay. Routes sit in an `(app)` group so an `(embed)` group can have its own root layout later (web-07).

Portfolio: one query per chain (`['vaults', chain, owner]`) through `useQueries`. A failing chain shows as unavailable on its own row and the others still render. The combined view is derived, never stored.

### Brand tokens

Rodrigo's brand tool outputs `palettes.json` and a tokens file on Oct 4 (`.design/branding/working-brand/ROADMAP.md`). `styles/tokens.css` has two layers:

1. Raw brand variables on `:root` (palette, fonts, radii). Neutral placeholders now.
2. Semantic names through Tailwind's `@theme inline` [10]: `bg`, `surface`, `fg`, `muted`, `border`, `accent`, `positive`, `negative`, `warning`, `mock`, a colour per asset class and per chain, `radius-card`, `font-display`, `font-sans`, `font-mono`.

Components use only semantic utilities (`bg-surface`). A CI grep rejects raw palette classes and hex values in `features/` and `components/ui/`. Fonts load through `next/font` into variables; name and logo come from `lib/brand.ts`; all copy is in message files. On Oct 4 the change is `tokens.css`, one font line, `brand.ts` and a copy pass.

### Languages and accessibility

- next-intl without locale routing: locale from a cookie, set from `Accept-Language` or `?lang=` in `proxy.ts`, read in `i18n/request.ts` [7]. No `[locale]` segment, so no route moves.
- Messages are `messages/{en,pt,es}/<feature>.json`. English is the source; a Vitest test fails on a key missing in any locale. Dates and numbers use next-intl's formatter with an explicit time zone, and `<html lang>` follows the locale (web-13).
- Dialogs, selects, tabs and switches come from the shadcn primitives. Status is icon plus text, never colour alone. Charts are SVG with `role="img"` and a table fallback. Every Playwright spec runs axe and checks for no sideways scroll at 375 px.

### Blocking US visitors

`proxy.ts` (Next 16's name for middleware, Node runtime [11]) reads `x-vercel-ip-country` [13], then `cf-ipcountry`, and rewrites to `/blocked` with status 451. A "not a US person" checkbox comes before the first deposit, since an IP is not a nationality. The API runs the same check, because agents call it directly.

### Tests

- **CI:** Playwright against the API's mock adapter with `TestWallet`, one spec per feature. Add `next build` to CI (web-15).
- **Fork, on demand:** the same specs against the anvil fork of Robinhood Chain and the local Solana validator from `spikes/`. Base cannot be forked (spike finding): mock or mainnet only.
- **Real Privy:** test accounts need email or SMS login [14], so enable email in a staging Privy app only. Passkeys can be driven with Chromium's virtual authenticator [memory]; the real check is by hand on two devices.

### Hosting

Vercel Hobby: free, native Next 16, 1M function invocations and 100 GB transfer a month, geo headers [12][13]; root directory `apps/web`. Fallback: `next start` beside the API with Cloudflare's free proxy in front. Cloudflare Workers through OpenNext supports Next 16.3.6 and up [1], but the free plan gives 10 ms of CPU per request [15], too little for server rendering.

## 3. What to skip or defer

- **wagmi:** viem covers the three calls we need.
- **Cache Components, React Compiler:** real gains, wrong week.
- **Locale-prefixed URLs, SEO:** cookie mode is half the work.
- **XState, Zustand:** a reducer and the query cache hold order state; the API is the store.
- **Dark mode, custom wallet modal, Storybook, Synpress** (last release Jan 2026 [1]).
- **`/monitor`, `/plans/[id]`, `/embed`:** leave until the new screens replace them, then delete in one commit.

## 4. Seams for the roadmap

- **Community and gamification:** reserve `/creators/[address]`; shelf cards take a `badges` slot.
- **Creator fees:** the order review renders `order.fees`, empty today.
- **Publish once with CCIP:** publish is already an order with a leg per chain; later it has one leg.
- **More chains:** `lib/chains.ts` (id, family, name, explorer, cash token, icon) drives every chain label; no `if (chain === ...)` in features.
- **New basket types:** the basket card picks its sections by `basket.kind` from a registry.
- **Rebalance on drift:** the rebalance order carries `trigger: 'index_update' | 'drift' | 'manual'`.
- **Paid price feeds:** one price badge renders `source`, `fetched_at`, `method` and market state for any source; unknown never shows as live (web-18).
- **Agent-run indexes:** `creator.kind: 'human' | 'agent'` on the index card; approval is `/orders/[id]`.
- **Pooled token:** holdings carry `holdingType: 'vault' | 'token'`.
- **Embeds:** the `(embed)` route group; basket card and risk sheet are server components with no wallet dependency.
- **Audits and governance:** the "unaudited, team holds the keys" notice reads one `TRUST_STATUS` constant next to `DISCLAIMER`.

## 5. Risks, and the test that settles each

| Risk | Test before Oct 9 |
|---|---|
| Privy on Next 16.3.8, Turbopack and React 19.3 is not documented [2] | Oct 2: the wallet spike as a page in `apps/web`. `next build` passes; passkey sign-up gives a Solana and an EVM address; one signature each on Solana, 4663 and 8453 |
| Two `@solana/kit` versions in one bundle | CI grep: `apps/web` imports no `@colosseum/chain-*`; drop those two `paths` from its tsconfig |
| "One tap" is several prompts for external wallets | Count prompts for a 6-leg, three-chain buy with Phantom plus MetaMask, and with a passkey wallet. Over about five: the demo uses the passkey wallet |
| A leg expires or the tab closes mid-order | Fork spec: close the page after leg 2 of 5, reopen `/orders/[id]`, finish. Second spec: reject a signature, then retry |
| The US block locks out people in the US | Decide question 1, then test from a US VPN exit |
| Passkey wallets are tied to a domain [16] | Choose the domain first; create a wallet there and open it on a second device. No demo wallets on preview URLs |
| Vercel Hobby is "non-commercial personal use only" [12] | The MVP takes no payment, so it likely fits. Decide question 3; rehearse `next start` once |
| Brand lands Oct 4 and forces rework | Oct 3: swap `tokens.css` for a different theme and run screenshots in three locales at 375 px. Every screen changes; axe contrast passes |
| Free RPC limits under portfolio polling | Chain reads go through the API cache. Five portfolio tabs for ten minutes, no 429s. Grep the bundle for RPC hosts (web-04) |

## 6. Questions only a person can answer

1. **US block and reviewers.** Some reviewers of the product are in the US. Should US visitors browse read-only without sign-in?
2. **Domain.** Which domain goes live? Passkey wallets bind to it and the name is not chosen.
3. **Hosting account.** Is Vercel Hobby acceptable given its non-commercial clause, and on whose account?
4. **Translated content.** Are index copy and risk sheets written in Portuguese and Spanish for the MVP, or only the interface?
5. **One-family wallets.** Someone connects Phantom only. Create an embedded EVM wallet for them, or ask for a second wallet?
6. **Rodrigo:** will the brand arrive as `palettes.json` plus a tokens file, and can `/monitor`, `/plans` and `/embed` be retired once the new screens land?

## 7. Sources

1. npm registry, read Oct 1, 2026, for every version and peer dependency: `https://registry.npmjs.org/<package>`
2. https://docs.privy.io/basics/react/installation
3. https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction , https://docs.privy.io/wallets/using-wallets/solana/kit-integrations
4. https://docs.privy.io/wallets/using-wallets/ethereum/web3-integrations , https://docs.privy.io/wallets/connectors/ethereum/integrations/wagmi
5. https://nextjs.org/docs/app/getting-started/caching-and-revalidating (16.3.8)
6. https://nextjs.org/docs/app/guides/caching-without-cache-components
7. https://next-intl.dev/docs/getting-started/app-router , https://next-intl.dev/docs/routing/setup
8. https://github.com/amannn/next-intl/issues/1493 (search result, not opened)
9. https://ui.shadcn.com/docs/installation/next
10. https://tailwindcss.com/docs/theme
11. https://nextjs.org/docs/app/api-reference/file-conventions/proxy
12. https://vercel.com/docs/plans/hobby , https://vercel.com/docs/limits/fair-use-guidelines
13. https://vercel.com/docs/headers/request-headers
14. https://docs.privy.io/recipes/using-test-accounts
15. https://developers.cloudflare.com/workers/platform/limits/
16. https://docs.privy.io/authentication/user-authentication/login-methods/passkey
17. Local: the audit reviewers' notes (outside this repo; summary in `docs/vault/AUDIT-VAULT.md`), `docs/vault/research/open-questions/wallet-providers.md`, `spikes/*/README.md`, `risk-layer/apps/web`, `risk-layer/packages/schemas/src/tx.ts`
