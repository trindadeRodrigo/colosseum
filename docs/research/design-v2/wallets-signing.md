# Design v2 note: wallets and signing

Oct 1, 2026. Docs, npm and GitHub read today; no account created, nothing signed. Claims are tagged (S#) for a source checked today, or (memory).

## 1. Bottom line

- **Privy holds up, with one catch on fees.** Passkey-only sign-up, Solana and EVM embedded wallets, custom chain 4663 and external wallets are all in the free plan (0–499 monthly users, 50K signatures) (S1, S2, S3). Its gas sponsorship is not free: it needs prepaid credits and a card, and Robinhood Chain is not on its list (S4). So the MVP uses a **funding check that includes gas**, on all three chains.
- **Fewest prompts without handing anyone the owner's key.** Passkey wallets: our own review screen, one tap, then silent signing leg by leg. External Solana wallets: one prompt for all legs. External EVM wallets: two prompts per chain the first time, one after, if the vault takes a batch of trades in one call.
- **No session signers, no Privy agent authorization.** Both give a server or an agent the owner's full signing power, and the owner path has no limits in the vault. Privy's policy engine, the only thing that would bound them, is on the Enterprise plan (S1). Automation stays in the keeper role, which the vault bounds.
- **The browser only handles bytes.** The API builds unsigned transactions and relays signed ones. The web app never imports a chain adapter. This also avoids a version clash: Privy needs `@solana/kit` 3.0.3 or newer, the repo's `chain-solana` is on 2.3.0 (S15).
- **Turnkey is no longer a free fallback:** 25 free signatures a month, then $0.10 each (S20). Switching costs about a day of work plus real money.

## 2. What to use for the MVP

**Packages** (npm, today, S15)

- `apps/web`: `@privy-io/react-auth` 3.46.0. It pins `viem` 2.56.0 exactly, so use 2.56.x in `apps/web` and `packages/chain-evm` to avoid two copies. Add `@solana/kit` at 3.0.3 or newer for `apps/web` only. Remove `@solana/wallet-adapter-*` and `@solana/web3.js` 1.x (the audit found they pull in React Native).
- `apps/api`: `jose` to verify tokens. No Privy app secret on the server.

**Privy settings** (S2, S3, S5, S6, S14)

- Login methods `passkey` and `wallet`. Execution in Privy's secure enclave (TEE), which is the default for new apps.
- `embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' }, solana: { createOnLogin: 'users-without-wallets' }, showWalletUIs: false }`.
- `supportedChains: [base, robinhood]`, where `robinhood` is viem `defineChain({ id: 4663, … })` with our own RPC URL. Privy's default RPCs are rate-limited.
- `externalWallets.solana.connectors: toSolanaWalletConnectors()`, `appearance.walletChainType: 'ethereum-and-solana'`.
- Two Privy apps: one for localhost, one locked to the production domain. Privy refuses `*.vercel.app` as an allowed origin (S13).

**One identity, three chains**

- One Privy user id is one person. New tables in `packages/db`: `users(id, privy_id)` and `wallets(user_id, family, address, kind)`, where family is `solana` or `evm` and kind is `embedded` or `external`.
- One EVM address serves Base and Robinhood Chain. A vault's owner is the active wallet of that family at creation and never changes (the spike's Solana vault address is derived from the owner).
- Someone who signs in with Phantom has no EVM address. Offer "connect an EVM wallet" or "create one" (`useCreateWallet`). Mixed is fine.

**API sign-in** (S12). `apps/api/src/plugins/auth.ts`: verify the Privy access token (ES256 JWT, issuer `privy.io`, audience our app id, one hour) with the dashboard's verification key; read linked wallets from the `privy-id-token` header. Apply it to every route with per-person data and restrict CORS to our origin. This closes the audit's "no auth, any origin" finding. Shelf, risk, `build*` and submit stay public. No route makes a server key sign.

**Signing a flow with the fewest prompts**

| Wallet | What the person does for a three-chain buy |
|---|---|
| Passkey (embedded) | Reads our review screen, taps once. Each leg is built fresh, signed without a Privy pop-up (`showWalletUIs: false`, S5) and sent. |
| External, Solana | One wallet prompt for all Solana legs: `signTransaction(...inputs)` takes several (S15, type file). Send in order before the blockhash expires; rebuild any leg that misses. |
| External, EVM | One prompt per transaction. First buy: `approve`, then one `createVaultAndDeposit(recipe, amount, trades[])`. Later: one `ownerRebalance(trades[])`. |

- This needs two things from the EVM contracts stream: a factory call that creates, deposits and trades, and an owner rebalance that takes an array.
- Does it weaken "only the vault enforces limits"? No. Nothing is delegated: the owner's key signs every owner transaction. The vault's limits bind the keeper, and the keeper stays the only automated signer. What would weaken it is any standing copy of owner authority off the device, which is why session signers are out.
- Honest limit: "one confirmation" is literally true only for passkey wallets. External wallets get one review screen, then up to five wallet prompts on a first buy.

**Sending.** The wallet signs; `POST /tx/submit` relays the signed bytes through the server's RPC, writes the `executions` row with its explorer link, and reads the result from the chain. This keeps RPC keys out of the bundle and stops trusting client reports (audit web-04, security-09). External EVM wallets cannot sign without sending, so they send through their own RPC and the server checks the hash onchain.

**Showing what is signed**

1. Every unsigned transaction carries a `preview` made by the adapter from a simulation: a plain sentence, balance changes for wallet and vault, the fee, and `source`, `fetched_at`, `method`. Solana: extend `packages/chain-solana/src/simulate.ts` to return post-simulation token balances. EVM: `eth_call` through viem in `packages/chain-evm/src/simulate.ts`.
2. A client-side guard, `apps/web/lib/wallet/guard.ts`, re-exported by the SDK. Before any signature it decodes the bytes and refuses anything off a short allowlist. Solana: top-level programs are ours, compute budget, associated token, the two token programs and system; the fee payer is the owner. EVM: `to` is the factory, the registry, the person's own vault, or the cash token with `approve` to the factory for the stated amount; chain id matches. About 100 lines. It answers the audit's "the browser signs what the API hands it".
3. External wallets also show their own simulation.

**Fees for a new user: a funding check.** `GET /funding?owner&chain&recipe` returns what is missing: cash, plus native gas. On Solana that is mostly rent for the vault's token accounts, roughly 0.002 SOL each (memory; the adapter computes it), plus fees. On Base and Robinhood Chain a swap costs cents (spike). The buy button stays disabled per chain until funded. Demo wallets are funded by hand.

**Export and recovery** (S11, S14)

- Settings has "Export key" per family (`useExportWallet`). The key is assembled on Privy's origin; the app never sees it.
- A person signs back in on a new device with any linked login. A passkey-only person who loses an unsynced passkey is locked out. After the first deposit, prompt them to add a second passkey or an email, or to export.
- Passkeys are bound to a domain. Create no real wallet until the production domain is fixed.
- Last resort, always true: in-kind withdrawal needs only the owner key. Ship `scripts/withdraw-without-app.ts`.

**Agents.** Three ways, none delegating the owner's key:

1. An agent with its own wallet owns its own vault: `build*` over REST, SDK or MCP, sign locally, `/tx/submit`.
2. An agent acting for a person posts an intent and gets an approval link. The person signs in, sees the same review screen and signs. Transactions are built at approval time, bound to the owner address in the intent.
3. An agent publishes an index with its own key; follower vaults bound what it can do.

**Files**

| Path | What |
|---|---|
| `packages/schemas/src/wallet.ts`, `tx.ts` | Types below. Extend Rodrigo's `UnsignedTx`; do not add a parallel type |
| `apps/web/app/providers.tsx` | `PrivyProvider` replaces wallet-adapter |
| `apps/web/lib/wallet/{port,privy,chains,guard,execute}.ts` | Interface, Privy implementation, chain 4663, guard, per-leg state machine |
| `apps/web/app/approve/[id]/page.tsx` | Approval page for intents |
| `apps/api/src/plugins/auth.ts`, `routes/{tx,funding,intents}.ts` | Sign-in check, relay, funding check, intents |
| `.env.example` | `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY`, EVM RPC URLs |

**Shapes to freeze on day 1**

```ts
// packages/schemas/src/tx.ts. Rodrigo's `Chain` ('solana' | 'evm') stays as the family.
export const ChainId = z.enum(['solana', 'base', 'robinhood']);
export const TxPreview = z.object({
  summary: z.string(),
  changes: z.array(z.object({ holder: z.enum(['wallet', 'vault']), asset: z.string(), deltaRaw: z.string() })),
  feeNativeRaw: z.string(), simulated: z.boolean(),
  source: z.string(), fetched_at: z.string(), method: z.string(),
});
// added to UnsignedTx: chainId, signer (address that must sign), feePayer (defaults to signer), preview

// packages/schemas/src/wallet.ts
export type WalletAccount = { family: Chain; address: string; kind: 'embedded' | 'external' };
export interface WalletPort {
  userId: string | null;
  accounts: WalletAccount[];
  active(family: Chain): WalletAccount | null;
  caps(chain: ChainId): { silent: boolean; batchSign: boolean; signOnly: boolean };
  sign(chain: ChainId, txs: UnsignedTx[]): Promise<string[]>;        // Solana any wallet; EVM embedded
  send(chain: ChainId, tx: UnsignedTx): Promise<{ txId: string }>;   // EVM external
  exportKey(family: Chain): Promise<void>;
  authHeaders(): Promise<Record<string, string>>;
}
// POST /tx/submit { chainId, signed, executionId } -> { txId, explorerUrl }
// POST /intents { kind, chainId, owner, params, agentLabel? } -> { id, approvalUrl, expiresAt }
```

Screens and the keeper code against `WalletPort` and a mock from day 1.

## 3. What to skip or defer

- **Sponsored fees.** Privy: prepaid credits, card, no Robinhood Chain (S4). Coinbase's paymaster: Base only, gas plus 7%, credits by application (S18). Pimlico lists 4663 and Base, but its free plan is testnets only (S17). Our own Solana fee payer (Kora, S19) is free of vendors but is one more service and can be drained through account rent.
- **Smart accounts, EIP-7702 batching, `wallet_sendCalls`** (S7, S16). The batch call in our own contract gets the same prompt count for every wallet.
- **Privy session signers and agent authorization** (a 30-day grant to sign as the user, S9, S10). Unbounded without the Enterprise policy engine.
- **Swig or any smart wallet as owner.** The owner stays a plain address everywhere.
- **Phantom Connect.** Colosseum's index recommends it (S21), but it has no passkey sign-up, chain 4663 is unconfirmed, and its portal was closed to new apps when `wallet-providers.md` was written. Connecting an existing Phantom wallet works through the wallet standard and must be flawless.
- **Mobile apps, SMS or social login, on-ramps.**

## 4. Seams for the roadmap

- **Community and gamification:** `users` is keyed by an internal id, so profiles and handles attach there.
- **Creator fees:** the registry stores the creator's address; fees go to that address, no new identity.
- **CCIP sync:** `wallets` records one EVM address per person across chains, so a creator is the same address on Base and Robinhood Chain.
- **More chains:** `ChainId` is an enum and `WalletPort` keys on family; a new EVM chain is one `defineChain`.
- **Protected basket and drift rebalancing:** store an `operator` address per vault (default: the platform keeper) for the keeper-only function. A new automation is a new operator under the same checks.
- **Agent-run indexes and agent rebalancing:** the same `operator` field is how a person later gives an agent limited authority, enforced by the vault.
- **Embeds for neobanks and advisers:** `WalletPort` has no Privy types in it; a partner's wallet is another implementation.
- **Sponsored fees later:** keep `payer` separate from `owner` in every Solana instruction that creates accounts, and keep `feePayer` on `UnsignedTx`. On EVM, never use `tx.origin` or "caller has no code" checks, so an EIP-7702 paymaster works unchanged (memory).
- **Audits and governance:** the guard's allowlist is one file, updated with each deployment.

## 5. Risks and the test that settles each

| Risk | Test before Oct 9 |
|---|---|
| Passkey-only sign-up does not create both wallets, or Privy cannot sign or send on 4663 | The seven-step spike in `wallet-providers.md` on Oct 2. Pass: a passkey wallet sends a transaction on 4663 and Base and a v0 transaction with a lookup table on Solana |
| Kit version clash in `apps/web` | `pnpm typecheck` and `next build` with `@solana/kit` 3 or newer in `apps/web` and 2.3.0 in `chain-solana` |
| Silent signing is too slow for a ten-leg buy | Time ten Solana signatures in the spike; pass under one second each |
| One Phantom prompt signs several legs but some expire | Sign five legs at once, send in order, count misses; if any, batch three at a time |
| Phantom cannot add chain 4663 (memory) | Try it; if so, the app offers MetaMask, Rabby or a created EVM wallet there |
| `users-without-wallets` gives a Phantom user no EVM wallet, or one they did not ask for | Log in with Phantom on a fresh account and inspect linked accounts |
| Passkey breaks when the domain changes | Create on a preview subdomain, log in on the final host |
| The guard rejects a valid transaction after a contract change | Unit tests over every `build*` output run in CI |

## 6. Questions only a person can answer

1. **Thom:** create the two Privy apps (it is a sign-up) and name the production domain before any demo wallet exists.
2. **Thom:** is Turnkey at about $0.10 a signature acceptable as the fallback, or is the fallback "connect a wallet only"?
3. **Thom and Rodrigo:** MVP item 4 says "one confirmation". Is "one review screen, then a wallet prompt per chain" acceptable for external wallets, with the demo run on a passkey wallet?
4. **Rodrigo:** OK to remove wallet-adapter from `apps/web` and put sign-in on every per-person API route?

## 7. Sources

- S1 https://www.privy.io/pricing
- S2 https://docs.privy.io/authentication/user-authentication/login-methods/passkey.md
- S3 https://docs.privy.io/basics/react/advanced/configuring-evm-networks.md
- S4 https://docs.privy.io/wallets/gas-and-asset-management/gas/setup.md , https://docs.privy.io/recipes/gas-sponsorship-rate-limits.md
- S5 https://docs.privy.io/recipes/react/manage-wallet-UIs.md
- S6 https://docs.privy.io/recipes/solana/getting-started-with-privy-and-solana.md , https://docs.privy.io/recipes/solana/standard-wallets.md
- S7 https://docs.privy.io/recipes/batch-transactions.md , https://docs.privy.io/recipes/react/eip-7702.md
- S9 https://docs.privy.io/wallets/using-wallets/signers/overview.md
- S10 https://docs.privy.io/recipes/agent-integrations/agent-authorization.md
- S11 https://docs.privy.io/wallets/wallets/export
- S12 https://docs.privy.io/authentication/user-authentication/access-tokens.md , https://docs.privy.io/user-management/users/identity-tokens.md
- S13 https://docs.privy.io/recipes/dashboard/allowed-domains.md
- S14 https://docs.privy.io/security/wallet-infrastructure/advanced/user-device
- S15 npm registry, Oct 1: `@privy-io/react-auth` 3.46.0 (dependencies, peer dependencies; type files at https://unpkg.com/@privy-io/react-auth@3.46.0/dist/dts/solana.d.ts), `@privy-io/node` 0.35.0, `viem` 2.57.2, `@solana/kit` 8.4.0
- S16 https://docs.robinhood.com/chain/account-abstraction/
- S17 https://docs.pimlico.io/guides/supported-chains , https://docs.pimlico.io/guides/pricing
- S18 https://docs.cdp.coinbase.com/paymaster/introduction/welcome
- S19 https://github.com/solana-foundation/kora (self-hosted Solana fee payer, v2.2.0-beta.8)
- S20 https://www.turnkey.com/pricing
- S21 https://ColosseumOrg.github.io/hackathon-resources/current.json
- Local: `risk-layer/apps/web/app/providers.tsx`, `packages/schemas/src/tx.ts`, `packages/chain-solana/src/{sign,simulate}.ts`, `apps/api/src/app.ts`; the audit reviewers' notes (outside this repo; summary in `docs/AUDIT-VAULT.md`), `audit-web.md`; `spikes/*/README.md`
