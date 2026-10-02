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
| `SignIn.tsx` | The "Sign in" button: a choice of passkey or wallet, the signed-in state, sign out |
| `dev/` | The page at `/dev/wallet`, its RPC reads and its two self-transfers |

## Using it

```tsx
import { SignIn, useApiFetch, useWalletPort } from '@/features/wallet';

const port = useWalletPort(); // WalletPort: status, accounts, active(), caps(), sign(), send()
const apiFetch = useApiFetch(); // fetch to the API with the sign-in headers
const res = await apiFetch('/v1/orders', { method: 'POST', body });
```

- **The token.** `port.authHeaders()` returns `authorization: Bearer <Privy access token>` and, once identity tokens are switched on in the Privy dashboard, `privy-id-token`. Signed out it returns `{}`. `useApiFetch()` adds them to a call; it is the one hook the fetch layer needs.
- **A signature.** Take the `BasketTx` the API built and look at `port.caps(chain).signOnly`. True: `port.sign(chain, [tx])` returns the signed transaction (base64 on Solana, 0x hex on EVM) and the caller reports it to the API. False (an outside EVM wallet): `port.send(chain, tx)` returns `{ txId }`.
- **Failures.** Every failure is a `WalletError` with one of its five codes. Where those cannot say why, the error is a `WalletPortError` with code `unknown` and a `reason`: `not_configured`, `not_connected`, `unsupported`, `wrong_signer`, `bad_transaction`, `changed`.
- **A mock transaction** (`provenance: 'mock'`) is not a transaction. The Privy wallet refuses it; the throwaway wallet hands its payload back unsigned.

## The throwaway wallet

`NEXT_PUBLIC_WALLET_DRIVER=test pnpm --filter @colosseum/web dev` puts it in place of Privy: sign-in is instant, the keys are made in memory and a reload makes new ones. It has no API token, so its calls reach the API with no sign-in.

It cannot reach a production build by accident:

1. It is imported only by the tests, by the dev page and by `test/test-bridge.tsx`, which the provider loads only when `NODE_ENV` is not `production`. `next build` drops that import.
2. `createTestDriver()` throws in a production build, and the bundler then drops the key code after the throw.
3. `scripts/check-build.mjs` runs after every `next build` (it is part of the `build` script) and fails the build if the throwaway wallet, the dev page or any route under `/dev` is in the output.

`/dev/wallet` is the file `app/dev/wallet/page.dev.tsx`. `next.config.ts` makes `dev.tsx` a route extension under `next dev` and in no other phase.

## Manual check: five minutes, by a person

An agent cannot do these: a real passkey, and a real signature on devnet and on chain 46630. Chrome or Safari, on the machine whose passkey you will keep.

**Before.** Privy dashboard: login methods passkey and wallet are on; embedded wallets are created on login for Solana and Ethereum; `http://localhost:3000` is an allowed origin. In `.env` at the repo root: the `NEXT_PUBLIC_PRIVY_APP_ID` line from `.env.example`. Then `pnpm --filter @colosseum/web dev` and open `http://localhost:3000/dev/wallet`.

| # | Do | You should see |
|---|---|---|
| 1 | Open the page | "Wallet check" and one black "Sign in" button. If it says "Sign-in is not set up here", the `.env` line is missing |
| 2 | Sign in, then Passkey | Privy's window, titled "Sign in", with "Continue with passkey". Create the passkey. The window closes |
| 3 | Look at the page | One line with `Solana xxxx…xxxx` and `EVM 0xxxxx…xxxx`, and "Sign out". `user id: did:privy:…`. Two panels: Solana on devnet, Robinhood Chain on "Robinhood Chain testnet, chain id 46630", each marked "test network", each with an address "(made at sign-in)" and "signs with no prompt". One address missing means embedded wallets are not created on login for that chain |
| 4 | Read the balance lines | `0 SOL` and `0 ETH`, each followed by "test network" and by its source, time and method (`api.devnet.solana.com · … · getBalance`), then "□ Not funded" |
| 5 | Send 0.01 devnet SOL to the Solana address and 0.0001 test ETH to the EVM address, from the two funded test addresses or the faucets. Press "Read the balance again" in each panel | The two amounts, and "■ Funded for the network fee" |
| 6 | Press "Sign a message" in each panel | No Privy window. Under each panel: "Signed, and the signature is valid for …". A Privy confirmation window here means `showWalletUIs: false` is not being honoured |
| 7 | Press "Sign and send: 1 lamport to yourself on devnet" | "Sent on devnet. Signed by" your Solana address, the signature, and "Tx ↗". The link opens Solscan on devnet: success, a transfer of 0.000000001 SOL from and to your address, fee 0.000005 SOL |
| 8 | Press "Sign and send: 1 wei to yourself on Robinhood Chain testnet" | "Sent on Robinhood Chain testnet. Signed by" your EVM address "(chain 46630)", the hash, and "Tx ↗". The explorer shows success, from and to your address, value 1 wei |
| 9 | Press "Show what the API receives" | `headers sent: authorization` (and `privy-id-token` once identity tokens are on), issuer `privy.io`, audience equal to the app id, subject equal to the user id above, an expiry about an hour ahead |
| 10 | Sign out, then Sign in, Passkey, and use the passkey you made | The same two addresses as in step 3 |

If a step fails, the sentence under the button is the report: copy it with the step number.

**The wallet path, if there is time.** Sign out. Sign in, Wallet, Phantom, and approve its sign-in message: the line shows `Solana …` only, the Solana panel says "an outside wallet" and "prompts for each signature", and the Robinhood Chain panel says no EVM wallet is connected. "Sign a message" opens Phantom. The same with MetaMask gives an EVM address only; "Sign and send" asks MetaMask to add or switch to chain 46630, then to confirm, and the result says the outside wallet sent it itself.
