# Sign-in and the wallet seam (WAL-1, WEB-1)

The app talks to a wallet through `WalletPort` (`packages/schemas/src/wallet.ts`) and never to Privy. Privy is named in one file, `privy-bridge.tsx`, and draws nothing at sign-in: the screen is ours, at `/sign-in`.

| File | What it is |
|---|---|
| `port.ts` | `createWalletPort(driver, chains)`: the half every wallet shares. It checks that a transaction is for this chain, this network and this account, hands the driver the bytes as they came, and turns every failure into a `WalletError`. It builds nothing and changes nothing |
| `driver.ts` | What a wallet provider has to do, with none of our types |
| `privy-bridge.tsx` | The Privy driver, on Privy's hooks that open no window (`useLoginWithPasskey`, `useSignupWithPasskey`, `useLoginWithSiwe`, `useLoginWithSiws`, `useCreateWallet`). Loaded in the browser only, and only once something calls `useWalletPort()` |
| `found-wallets.ts` | The outside wallets in this browser: EVM wallets as they announce themselves (EIP-6963), Solana wallets from the wallet standard's registry |
| `sign-in-flows.ts` | Sign-in with an outside wallet, EVM and Solana: ask for the account, have it sign Privy's message, hand both to Privy. And `missingWallets`: which embedded wallets a passkey sign-in still owes |
| `sign-in-view.ts` | Which sentence a failed sign-in gets |
| `test/test-driver.ts` | A driver made of throwaway keys, for tests and for work on the mock |
| `chains.ts` | Which network each chain is on in the browser, from the shared chain configs, with the public RPC URLs |
| `bytes.ts` | base58, base64, and reading a Solana transaction's signers and fee payer |
| `WalletProvider.tsx` | `<WalletProvider>`, `useWalletPort()`, `useApiFetch()`. A screen's port has no signing member |
| `signing.ts` | `useSigningPort()`: the whole port, with `sign()`, `send()`, `signMessage()` and `exportKey()`. No product route may import it yet |
| `api-url.ts` | The address of an API call: one path under the API, never another host |
| `config-check.ts`, `use-api-check.ts` | At start, the browser's networks against the API's `GET /v1/config` |
| `SignIn.tsx` | The two ways in, on the primitives: create a passkey or use one, or a wallet from the list of those found. The screen around it, and the chain pick, are in `features/account/` |
| `dev/` | The page at `/dev/wallet`, its RPC reads and its two self-transfers |

## Using it

```tsx
import { SignIn, useApiFetch, useWalletPort } from '@/features/wallet';

const port = useWalletPort(); // status, userId, accounts, active(), caps(), signIn(), signOut(),
//   found, problemKind, network(chain), walletsOwed, ensureWallets(). No sign(), no send().
const apiFetch = useApiFetch(); // fetch to the API with the sign-in headers
const res = await apiFetch('/v1/orders', { method: 'POST', body });
```

- **The token.** `port.authHeaders()` returns `authorization: Bearer <Privy access token>` and, once identity tokens are switched on in the Privy dashboard, `privy-id-token`. Signed out it returns `{}`. `useApiFetch()` adds them to a call; it is the one hook the fetch layer needs. Its `path` starts with one `/` and stays under the API: anything that would name another host is refused before the token is asked for, and a redirect is an error.
- **A signature** is not a screen's to ask for. What `useWalletPort()` returns is the wallet with its signing members taken off: the object does not have them. The whole port is `useSigningPort()` in `signing.ts`, for the one leg executor once the guard exists, and today for the page under `/dev`. With the whole port: take the `BasketTx` the API built and look at `port.caps(chain).signOnly`. True: `port.sign(chain, [tx])` returns the signed transaction (Solana: base64 of the whole serialized transaction; EVM: the 0x serialized signed transaction), one per transaction given and in the same order, and the caller reports it to the API as `signedTx`. False (an outside EVM wallet): `port.send(chain, tx)` returns `{ txId }`.
- **Failures.** Every failure is a `WalletError` with one of its nine codes: `rejected`, `expired`, `no_gas`, `wrong_chain`, `not_connected`, `wrong_account`, `unsupported`, `changed`, `unknown`. The port throws a `WalletPortError`, which also carries a `reason`. For the last four named codes the reason is the code. Two reasons are this app's alone and travel under `unknown`: `not_configured` and `bad_transaction`.
- **A failed sign-in** carries one of nine more reasons, and `sign-in-view.ts` gives each a sentence of the dictionary (`i18n/en.ts`, `signIn.failure`): `method_off` (Privy's 403 "Login with passkey not allowed": the method is off in its dashboard), `passkey_cancelled` (the prompt was closed or ran out), `passkey_unknown`, `passkey_unsupported`, `wallet_gone`, `wallet_silent`, `too_many`, `offline`, `wallet_not_made`. A person never reads what Privy or a wallet threw.
- **Which chain.** `port.network(chain)` gives the name, the network and the provenance of a chain as the API runs it, for the words on screen. Which chain a person's plan lives on is not the port's to say: `useAccount()` in `features/account/` asks the API.
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

## Sign-in, as built (WEB-1)

- **A passkey** is two buttons, because they are two calls: "Create a passkey" (`signupWithPasskey`) and "Use a passkey I already have" (`loginWithPasskey`). A person with no passkey for this site can make one.
- **A wallet** is one of those found in the browser, listed by its own name with its family. An EVM wallet signs in with SIWE, a Solana wallet with SIWS; WalletConnect is not listed. With none found, the screen says so and points to the passkey.
- **Embedded wallets are made by the driver.** Privy makes none by itself after a sign-in through its hooks, so `createOnLogin` is off and the driver makes one wallet of each family for a person whose sign-in has no outside wallet. The port stays `loading` until both are there. If making one fails, the port is ready without it, the screen says so, and `port.ensureWallets()` tries again.
- **The chain.** After sign-in the screen asks `GET /v1/me`. A person who made their wallet here is asked once which chain their plan lives on and the answer goes to `PUT /v1/me/chain`; a person who connected a wallet is never asked. From then on the product shows and uses only the wallet of that chain: `port.active(chainFamily(chain))`. The other family's embedded wallet exists and is never shown.
- **The throwaway wallet** has no account on the API: its chain is worked out in the page and kept while the page is open, under the MOCK plate with its hatch.

## Before any product screen signs

1. Nothing in product code calls `port.sign()` or `port.send()` until the guard (AGT-1) has checked the bytes against the order. The port checks that a transaction is for this account and network and that the wallet signed what it was given. It does not know what the order was, so it cannot tell a deposit from a transfer to someone else. `components/shell/product-routes.test.ts` (rule 3) holds this by what a screen can reach, not by how a call is spelled:
   - the port a screen is handed has no signing member (`screen-port.events.test.ts` sees it with the provider mounted);
   - nothing the app ships imports `signing.ts`, and a file outside the seam takes from a seam file only `useWalletPort`, `useApiFetch`, `WalletProvider` and types;
   - a screen imports only the packages on the test's list, which has no wallet or chain library, and `@privy-io` is imported by `privy-bridge.tsx` alone;
   - outside the seam no signing member is named at all: not called, read, taken apart, handed on as a prop or written as a string, and neither is a wallet's own method (`eth_sendTransaction`, `solana:signTransaction`) or `window.ethereum`.

   The seam is the nine files the test lists: `port.ts`, `driver.ts`, `privy-bridge.tsx`, `WalletProvider.tsx`, `signing.ts`, `sign-in-flows.ts`, `found-wallets.ts`, `chains.ts`, `bytes.ts`. What the test cannot read in a file, a key built at run time or the port handed to a helper, comes to nothing because the object has no such member, and the typecheck refuses it.
2. Privy still owns one window: the export of a key. It has rounded corners and a blurred backdrop, which `STYLE.md` forbids. Nothing in the product opens it yet.

## The throwaway wallet

`NEXT_PUBLIC_WALLET_DRIVER=test pnpm dev` puts it in place of Privy: sign-in is instant, the keys are made in memory and a reload makes new ones. It has no API token, so its calls reach the API with no sign-in. The API has to be running for it too.

It cannot reach a production build by accident:

1. It is imported only by the tests, by the dev page and by `test/test-bridge.tsx`, which the provider loads only when `NODE_ENV` is not `production`. `next build` drops that import.
2. `createTestDriver()` throws in a production build, and the bundler then drops the key code after the throw.
3. `scripts/check-build.mjs` runs after every `next build` (it is part of the `build` script) and fails the build if the throwaway wallet, the dev page or any route under `/dev` is in the output, or if the source maps of the server side name a file of `dev/` or `test/`.
4. `imports.test.ts` fails if any shipped file imports from `dev/` or `test/`, the provider's one guarded import apart.

`/dev/wallet` is the file `app/(app)/dev/wallet/page.dev.tsx`, under the product's layout and so inside its shell. `next.config.ts` makes `dev.tsx` a route extension under `next dev` and in no other phase.

Signed in with it on `/sign-in`, the passkey button gives a wallet of each family, so the chain is asked; a wallet button gives that one wallet, so it is not.

## Manual check: by a person with a passkey

An agent cannot do these: a real passkey, a real wallet's approval, and a real signature on devnet and on chain 46630. Chrome or Safari, on the machine whose passkey you will keep.

**Before.**

- Privy dashboard: login methods passkey and wallet are on; identity tokens are on; `http://localhost:3000` is an allowed origin. "Create on login" for embedded wallets no longer matters: the app makes them.
- In `.env` at the repo root: the `NEXT_PUBLIC_PRIVY_APP_ID` line from `.env.example`, and `PRIVY_APP_ID` with the same value for the API.
- The API answers `GET /v1/me` only to a verified sign-in. If the screen says "I can't tell yet which chain your plan lives on" after a sign-in that worked, the API refused that call: `PRIVY_APP_ID` is not set for it (503), identity tokens are off in the dashboard (401), or the web's origin is not in `CORS_ORIGINS` (it is `http://localhost:3000` when unset).
- `pnpm dev`, which starts the API and the web. Use `localhost`, not `127.0.0.1`.

### The product screen: `http://localhost:3000/sign-in`

| # | Do | You should see |
|---|---|---|
| 1 | Open the page | "Sign in with a wallet that is yours." and two cards, Passkey and Wallet. No window of Privy's at any step below. "Sign-in is off for the moment: our server isn't answering" means the API is not up: it clears by itself. "Sign-in is off here: this copy of the app isn't set up correctly" has the reason under it, after "For the team" |
| 2 | Press "Create a passkey" and make it | The button reads "Waiting for your passkey…", then the page reads "Making your wallet…", then "You're signed in." and the card "Choose the chain your plan lives on" with Solana and Robinhood Chain, each with the MOCK plate, "test network" and "Your wallet there: …". "Passkeys aren't switched on for this app yet" is Privy's 403: the login method is off in the dashboard |
| 3 | Press "Choose a chain" without choosing | The button is off; under it, "Choose a chain to continue." |
| 4 | Choose Robinhood Chain, press "My plan lives on Robinhood Chain" | You land on `/goal`. The bar shows one short address, the `0x` one, and "Sign out" |
| 5 | Reload `/goal`, then open `/sign-in` | No question. `/sign-in` says "Your plan lives on Robinhood Chain. You chose that, and it stands." with the same address |
| 6 | Sign out. On `/sign-in` press "Use a passkey I already have" and use it | No question; the same address in the bar. This is what a second device does: do it on one if the passkey syncs |
| 7 | Sign out. Press "Create a passkey" and close the browser's prompt | "The passkey wasn't created: the prompt was closed or ran out of time. Nothing was saved. Try again when you're ready." |
| 8 | Press "Use a passkey I already have" and close the prompt | "No passkey was used: the prompt was closed or ran out of time. If you have no passkey for this site yet, create one." |
| 9 | With Phantom installed: press "Phantom · Solana" and approve its message | You land on `/goal` with no question. The bar shows the Phantom address. `/sign-in` says "Your plan lives on Solana, the chain of the wallet you connected." |
| 10 | Sign out. Press "Phantom · Solana" and reject in Phantom | "Your wallet declined the request, so nothing was signed and you aren't signed in. Try again and approve it in the wallet." |
| 11 | Sign out. With MetaMask installed: press "MetaMask · Ethereum" and approve | You land on `/goal` with no question, the `0x` address in the bar, and `/sign-in` says Robinhood Chain |
| 12 | On `/goal`, signed in: type a goal, press Enter, fill what is empty | The limits list "Chain" with your chain and "test network". "Build my plan" works only when every field fits. Until the API can build a plan it answers "Your limits are set. The plan can't be built yet." |

If step 2 ends in "You're signed in, but no wallet is linked to this sign-in yet", press "Make my wallet" and note it: the API's identity token did not list the new wallets the first time. If it ends in "You're signed in, but your wallet couldn't be made", the same button tries again: copy the line after "For the team" if there is one.

### Signing: `http://localhost:3000/dev/wallet`

The page is inside the product's bar. Signed out it shows the same two cards; sign in with the passkey from above.

| # | Do | You should see |
|---|---|---|
| 1 | Look at the page | `user id: did:privy:…`. Two panels: Solana on devnet, Robinhood Chain on "Robinhood Chain testnet, chain id 46630", each marked "test network", each with an address "(made at sign-in)" and "signs with no prompt". Both wallets show here whatever chain was picked: this page is not the product. One address missing means that wallet was not made |
| 2 | Read the balance lines | `0 SOL` and `0 ETH`, each followed by "test network" and by its source, time and method (`api.devnet.solana.com · … · getBalance`), then "□ Not funded" |
| 3 | Send 0.01 devnet SOL to the Solana address and 0.0001 test ETH to the EVM address, from the two funded test addresses or the faucets. Press "Read the balance again" in each panel | The two amounts, and "■ Funded for the network fee" |
| 4 | Press "Sign a message" in each panel | No Privy window. Under each panel: "Signed, and the signature is valid for …". A Privy confirmation window here means `showWalletUIs: false` is not being honoured |
| 5 | Press "Sign and send: 1 lamport to yourself on devnet" | "Sent on devnet. Signed by" your Solana address, the signature, and "Tx ↗". The link opens Solscan on devnet: success, a transfer of 0.000000001 SOL from and to your address, fee 0.000005 SOL. "this browser cannot check an Ed25519 signature" means the browser is too old for the check the port makes on what comes back |
| 6 | Press "Sign and send: 1 wei to yourself on Robinhood Chain testnet" | "Sent on Robinhood Chain testnet. Signed by" your EVM address "(chain 46630)", the hash, and "Tx ↗". The explorer shows success, from and to your address, value 1 wei. "the wallet set a fee above the … allowed" means Privy chose a fee more than ten times the page's own estimate: copy the sentence |
| 7 | Press "Show what the API receives" | `headers sent: authorization` and `privy-id-token`, issuer `privy.io`, audience equal to the app id, subject equal to the user id above, an expiry about an hour ahead |
| 8 | Sign out in the bar, then use the passkey again | The same two addresses as in step 1 |

If a step fails, the sentence on the page is the report: copy it with the step number.

**The wallet path, if there is time.** Signed in with Phantom, `/dev/wallet` shows the Solana panel as "an outside wallet" that "prompts for each signature", and no EVM wallet. "Sign a message" opens Phantom. With MetaMask it shows an EVM address only; "Sign and send" asks MetaMask to add or switch to chain 46630, then to confirm, and the result says the outside wallet sent it itself. If Phantom's "Sign and send" ends in "the wallet signed a different transaction from the one it was given", Phantom added instructions of its own: note it, it decides whether Solana needs a `send()`.
