# Sign-in and the wallet seam (WAL-1)

The app talks to a wallet through `WalletPort` (`packages/schemas/src/wallet.ts`) and never to Privy. Privy is named in one file, `privy-bridge.tsx`.

| File | What it is |
|---|---|
| `port.ts` | `createWalletPort(driver, chains)`: the half every wallet shares. It checks that a transaction is for this chain, this network and this account, hands the driver the bytes as they came, and turns every failure into a `WalletError`. It builds nothing and changes nothing |
| `driver.ts` | What a wallet provider has to do, with none of our types |
| `privy-bridge.tsx` | The Privy driver. Loaded in the browser only, and only once something calls `useWalletPort()` |
| `test/test-driver.ts` | A driver made of throwaway keys, for tests and for work on the mock |
| `chains.ts` | Which network each chain is on in the browser, from the shared chain configs, with the public RPC URLs |
| `bytes.ts` | base58, base64, and reading a Solana transaction's signers and fee payer |
| `WalletProvider.tsx` | `<WalletProvider>`, `useWalletPort()`, `useApiFetch()` |
| `api-url.ts` | The address of an API call: one path under the API, never another host |
| `config-check.ts`, `use-api-check.ts` | At start, the browser's networks against the API's `GET /v1/config` |
| `SignIn.tsx` | The "Sign in" button: a choice of passkey or wallet, the signed-in state, sign out |
| `dev/` | The page at `/dev/wallet`, its RPC reads and its two self-transfers |

## Using it

```tsx
import { SignIn, useApiFetch, useWalletPort } from '@/features/wallet';

const port = useWalletPort(); // WalletPort: status, accounts, active(), caps(), sign(), send()
const apiFetch = useApiFetch(); // fetch to the API with the sign-in headers
const res = await apiFetch('/v1/orders', { method: 'POST', body });
```

- **The token.** `port.authHeaders()` returns `authorization: Bearer <Privy access token>` and, once identity tokens are switched on in the Privy dashboard, `privy-id-token`. Signed out it returns `{}`. `useApiFetch()` adds them to a call; it is the one hook the fetch layer needs. Its `path` starts with one `/` and stays under the API: anything that would name another host is refused before the token is asked for, and a redirect is an error.
- **A signature.** Take the `BasketTx` the API built and look at `port.caps(chain).signOnly`. True: `port.sign(chain, [tx])` returns the signed transaction (Solana: base64 of the whole serialized transaction; EVM: the 0x serialized signed transaction), one per transaction given and in the same order, and the caller reports it to the API as `signedTx`. False (an outside EVM wallet): `port.send(chain, tx)` returns `{ txId }`.
- **Failures.** Every failure is a `WalletError` with one of its nine codes: `rejected`, `expired`, `no_gas`, `wrong_chain`, `not_connected`, `wrong_account`, `unsupported`, `changed`, `unknown`. The port throws a `WalletPortError`, which also carries a `reason`. For the last four named codes the reason is the code. Two reasons are this app's alone and travel under `unknown`: `not_configured` and `bad_transaction`.
- **A mock transaction** (`provenance: 'mock'`) is not a transaction. The Privy wallet refuses it; the throwaway wallet hands its payload back unsigned.

## What the port checks

Before a key is touched:

- The transaction is for the chain asked, the family and the address of the active account.
- Its label is the network this app is on: `sandbox` on a test network, `live` on mainnet. Solana's bytes name no network, so this is all that tells devnet from mainnet. `fixture` and `prior_dataset` are refused; `mock` goes to the throwaway wallet only.
- Solana: the payload is base64 of a whole legacy or version 0 transaction, the account is one of its signers, and its fee payer is the one stated.
- EVM: the chain id is the one this app is on, the target is an address, the value is a raw amount, the call data is whole bytes of hex.

After the wallet answers, before anything is returned as signed:

- Solana: as many transactions as were sent, in the same order, each with the same message byte for byte and a valid signature of this account in its slot.
- EVM: a legacy or EIP-1559 transaction with no access list, the same target, data, value and chain, signed by this account, with `gas × fee per gas` no more than ten times the fee the transaction states, or no more than 0.001 ETH when it states none (`chains.ts`). The wallet fills in the nonce, the gas and the fee, so this is the only place the whole signed transaction is seen.

A wallet that adds instructions before it signs, as Phantom does to some transactions, fails with `changed`: `sign()` hands back only what the API built. The design's other path for such a wallet (it sends, the web reports the id) needs a `send()` on Solana, which `WalletPort` does not have.

## The API has to agree on the networks

The browser reads `NEXT_PUBLIC_CHAIN_NETWORK_<CHAIN>` and the API reads `CHAIN_NETWORK_<CHAIN>`. Before the wallet provider is mounted, the app asks `GET /v1/config` and compares the network and the EVM chain id of every chain the API has on. If they differ, or the API does not answer, sign-in is off and the button says why; an API that does not answer is asked again every five seconds. The app never falls back to its own table.

## Before any product screen signs

Not done in this slot, and each has to be true first:

1. Nothing in product code calls `port.sign()` or `port.send()` until the guard (AGT-1) has checked the bytes against the order. The port checks that a transaction is for this account and network and that the wallet signed what it was given. It does not know what the order was, so it cannot tell a deposit from a transfer to someone else.
2. The throwaway wallet's `MOCK` label is a word in a border. It needs the hatch plate from BRAND-1 (`mock-plate.md`).
3. Privy's own window has rounded corners and a blurred backdrop, which `STYLE.md` forbids. The way out is Privy's headless hooks (`useLoginWithPasskey`, `useSignupWithPasskey`, `useLoginWithSiwe`, `useLoginWithSiws`) behind the same `signIn()`.
4. `<SignIn>` is mounted on `/dev/wallet` only. No production page shows it yet.

## The throwaway wallet

`NEXT_PUBLIC_WALLET_DRIVER=test pnpm dev` puts it in place of Privy: sign-in is instant, the keys are made in memory and a reload makes new ones. It has no API token, so its calls reach the API with no sign-in. The API has to be running for it too.

It cannot reach a production build by accident:

1. It is imported only by the tests, by the dev page and by `test/test-bridge.tsx`, which the provider loads only when `NODE_ENV` is not `production`. `next build` drops that import.
2. `createTestDriver()` throws in a production build, and the bundler then drops the key code after the throw.
3. `scripts/check-build.mjs` runs after every `next build` (it is part of the `build` script) and fails the build if the throwaway wallet, the dev page or any route under `/dev` is in the output, or if the source maps of the server side name a file of `dev/` or `test/`.
4. `imports.test.ts` fails if any shipped file imports from `dev/` or `test/`, the provider's one guarded import apart.

`/dev/wallet` is the file `app/dev/wallet/page.dev.tsx`. `next.config.ts` makes `dev.tsx` a route extension under `next dev` and in no other phase.

## Manual check: five minutes, by a person

An agent cannot do these: a real passkey, and a real signature on devnet and on chain 46630. Chrome or Safari, on the machine whose passkey you will keep.

**Before.** Privy dashboard: login methods passkey and wallet are on; embedded wallets are created on login for Solana and Ethereum; `http://localhost:3000` is an allowed origin. In `.env` at the repo root: the `NEXT_PUBLIC_PRIVY_APP_ID` line from `.env.example`. Then `pnpm dev`, which starts the API and the web, and open `http://localhost:3000/dev/wallet`. The API has to be up: sign-in stays off until it answers.

| # | Do | You should see |
|---|---|---|
| 1 | Open the page | "Wallet check" and one black "Sign in" button. "Sign-in is off here: NEXT_PUBLIC_PRIVY_APP_ID is not set" means the `.env` line is missing. "…the API at localhost:3001 cannot be reached" means the API is not up yet: it clears by itself within five seconds of the API answering. A sentence that names a chain and `NEXT_PUBLIC_CHAIN_NETWORK_…` means the API and the web are set to different networks |
| 2 | Sign in, then Passkey | Privy's window, titled "Sign in", with "Continue with passkey". Create the passkey. The window closes |
| 3 | Look at the page | One line with `Solana xxxx…xxxx` and `EVM 0xxxxx…xxxx`, and "Sign out". `user id: did:privy:…`. Two panels: Solana on devnet, Robinhood Chain on "Robinhood Chain testnet, chain id 46630", each marked "test network", each with an address "(made at sign-in)" and "signs with no prompt". One address missing means embedded wallets are not created on login for that chain |
| 4 | Read the balance lines | `0 SOL` and `0 ETH`, each followed by "test network" and by its source, time and method (`api.devnet.solana.com · … · getBalance`), then "□ Not funded" |
| 5 | Send 0.01 devnet SOL to the Solana address and 0.0001 test ETH to the EVM address, from the two funded test addresses or the faucets. Press "Read the balance again" in each panel | The two amounts, and "■ Funded for the network fee" |
| 6 | Press "Sign a message" in each panel | No Privy window. Under each panel: "Signed, and the signature is valid for …". A Privy confirmation window here means `showWalletUIs: false` is not being honoured |
| 7 | Press "Sign and send: 1 lamport to yourself on devnet" | "Sent on devnet. Signed by" your Solana address, the signature, and "Tx ↗". The link opens Solscan on devnet: success, a transfer of 0.000000001 SOL from and to your address, fee 0.000005 SOL. "this browser cannot check an Ed25519 signature" means the browser is too old for the check the port makes on what comes back |
| 8 | Press "Sign and send: 1 wei to yourself on Robinhood Chain testnet" | "Sent on Robinhood Chain testnet. Signed by" your EVM address "(chain 46630)", the hash, and "Tx ↗". The explorer shows success, from and to your address, value 1 wei. "the wallet set a fee above the … allowed" means Privy chose a fee more than ten times the page's own estimate: copy the sentence |
| 9 | Press "Show what the API receives" | `headers sent: authorization` (and `privy-id-token` once identity tokens are on), issuer `privy.io`, audience equal to the app id, subject equal to the user id above, an expiry about an hour ahead |
| 10 | Sign out, then Sign in, Passkey, and use the passkey you made | The same two addresses as in step 3 |

If a step fails, the sentence under the button is the report: copy it with the step number.

**The wallet path, if there is time.** Sign out. Sign in, Wallet, Phantom, and approve its sign-in message: the line shows `Solana …` only, the Solana panel says "an outside wallet" and "prompts for each signature", and the Robinhood Chain panel says no EVM wallet is connected. "Sign a message" opens Phantom. The same with MetaMask gives an EVM address only; "Sign and send" asks MetaMask to add or switch to chain 46630, then to confirm, and the result says the outside wallet sent it itself. If Phantom's "Sign and send" ends in "the wallet signed a different transaction from the one it was given", Phantom added instructions of its own: note it, it decides whether Solana needs a `send()`.
