# Orders: what this folder does, and what it does not do yet

The order layer behind `/v1/orders` (DESIGN-VAULT 3.3). It plans the legs of an order, builds one unsigned transaction per leg, and settles a leg when the chain says its transaction landed. It holds no key and signs nothing. Today it runs on `packages/chain-mock` only; a real adapter drops in behind the same `ChainAdapter`.

| File | What it holds |
|---|---|
| `prepare.ts` | `planBuy` and `prepareIntent`: a buy of a stored plan becomes legs on one chain. The targets a plan opens into (`targetsOf`), the trades of a deposit (`tradesFor`), the policy numbers (`ORDER_POLICY`) |
| `person.ts` | The chain a person's plans live on: the one stored on the user, at a pick or the first time an outside wallet named it |
| `legs.ts` | Build, report, cancel, and the read that tracks sent legs again. `attemptFor`: which attempt a transaction is |
| `store.ts` | The tables, through Drizzle. Every writer locks the leg row first, then its attempts; an EVM build takes a lock on (chain, wallet) before that |
| `chains.ts` | The adapter registry by chain mode |
| `errors.ts` | A refusal (its body is the shared `OrderError`); a chain's refusal mapped onto the order codes |

## The rules an order follows

- An order is on one chain: the chain the person's plans live on (`GET /v1/me`). The plan it buys has one recipe, on that chain. Only a publish order will have legs on more than one. A buy that sends `chains` is refused with a sentence. An order stored with steps on two chains, from before this rule, answers 409 with "make the order again" on read, build, report and cancel, and nothing is written for it.
- The person's chain is stored once and stands: at a pick, or the first time an outside wallet names it. A wallet of the other family linked later does not move it.
- A buy deposits the whole amount. The order says it once (`depositRaw`): that is the figure to show and to add up. The approval and the step that deposits both repeat it (`cashRaw`), so on a chain that needs an approval the legs add up to twice the deposit. The trades spend the invested share: the deposit times the sum of the targets over 10,000, rounded down. The rest stays in the vault as cash. A plan with no target is all cash.
- A shared portfolio a plan holds as one line is opened into its assets before the vault sees it. If it has changed since the plan was made, or since the order was made, the answer is `VERSION_CHANGED`.

## The rules a leg follows

- A leg is not built again while the transaction built before can still land. On Solana that is until the chain is past the attempt's `validUntil`. On an EVM chain nothing expires, so the attempt stays open until it is reported or the person cancels it (`POST .../cancel`).
- On an EVM chain a wallet has one next nonce. A step is not built while another order of the same wallet holds a transaction on that chain that can still land: 409, with `details.blocking` naming the order and the step. An order that expired does not count.
- A report, by id or by signed bytes, is matched against every attempt of the leg. The leg settles on the attempt that landed, whatever that attempt was labelled.
- On an EVM chain an attempt is the pair (message, nonce), and the nonce is read from the transaction itself (`nonceOf`). Two attempts that state the same pair are one transaction: the newest that can still land is the one. A transaction on a nonce no attempt states is the wallet's own choice and goes to the newest open attempt, unless another step stated that pair, the step is already settled, or the nonce is below every nonce the step stated: that one was sent before the step was built, an older identical call, and settles nothing. The attempt is left carrying the nonce the wallet used.
- A reported id the chain has not seen yet is not the wrong transaction. The answer is 409 with `details.retryable` true, nothing is written, and the caller reports again.
- An attempt that the chain has confirmed or reverted is never rewritten. Anything else (`built`, `sent`, `expired`) can still be corrected by what the chain says.
- Signed bytes are relayed once, only for an attempt that is `built`, and never for an order that has expired (410 `ORDER_EXPIRED`, nothing sent). A transaction the wallet sent itself is still recorded after expiry, when it is reported by id.
- One transaction settles one step. A transaction already recorded against another step is refused here, and an attempt whose nonce it used is closed.
- The first transaction the chain has seen keeps an open order open for 24 hours. A transaction that is only claimed does not, and nothing reopens an order that expired.

## What moved into the shared packages

The response shapes (`OrderDetail`, `PortfolioResponse`, `PersonResponse`, `FundingResponse`, `OrderError` with the chain's code, `retryable` and `blocking` in `details`) and the five adapter calls behind a report (`TxProbe`) are in `packages/schemas`. `Leg.expected` has one figure per trade, `Leg.cashRaw` the cash a step is about, and `Order.depositRaw` the cash the order moves, once. `GET /v1/funding` reads one wallet and names it: the one the query names (`wallet`, one of the person's on their chain), else the one the plans are held by. The amount ceiling and the slippage cap are `ORDER_LIMITS`, held by the request's schema; `ORDER_POLICY.slippageBps` is only the figure a buy gets when it names none. The rate limits are `LIMITS` in `plugins/limits.ts`.

## Before a real chain

None of this is built. Each item is a way to lose money or trust once a chain is `live`.

1. **Idempotency keys on order creation.** Two identical buys sent at once make two orders, and both can settle. `POST /v1/orders` has to take a key and answer the second request with the first order (`idempotency_keys` exists). On an EVM chain the second order now waits for the first one's open transaction; on Solana nothing stops both.
2. **Relay, "carries" and `nonceOf` through the real adapters.** The five calls are part of `ChainAdapter` (`TxProbe`), and the mock is the only adapter that has them. A real adapter has to hash signed bytes back to the message it built, broadcast them, read the nonce a transaction was signed with, and fetch a reported transaction and match signer, target and call data to the attempt (on Solana, our instruction's accounts and data). The contract's "signed bytes" cases hold it to that.
3. **Finding a landing nobody reported.** The mock can be asked about an attempt by its message, because its transaction ids are derived from it. A real chain cannot: on Solana the adapter has to search the signer's signatures, on EVM compare the account's nonce. `fate` is handed the signer and the nonce for that. Without it, a transaction that landed and was never reported is found only when its id arrives.
4. **An outside EVM wallet that picks its own nonce, with two identical steps.** Two orders of one wallet with the same call (the same deposit into the same vault) share a message. Where the wallet signs on the stated nonce, each transaction is told apart by it. Where it does not, a transaction on a nonce nobody stated, at or above the lowest the step stated, settles the step it is reported to: the books then hold one deposit for one transaction, but possibly against the other order. A nonce below every stated one is refused: that transaction was sent before the step was built. The embedded wallet signs with the stated nonce and is not affected.
5. **A second order of the same wallet on an EVM chain waits.** It is refused while the first holds an open transaction, and the web has to offer the way out: report or cancel the step named in `details.blocking`. An order left open and unsigned blocks until it expires, 15 minutes later.
6. **`users` and `user_wallets`.** A `users` row is written when a person picks their chain, or the first time their outside wallet names it, and holds the chain. Nothing writes `user_wallets`, `orders.user_id` is null, and an order is tied to wallets only.
7. **The client address behind a proxy, limits per address for signed-in callers, and `@fastify/helmet`.** The anonymous limit is by the address the request came from. Behind the web app's server every anonymous caller shares its address until the API trusts a forwarded one, with the shared secret the design names. A signed-in caller is counted by person only, so one address with many identities gets the full budget for each: there is no limit per address beside it yet.
8. **Any signed-in person can buy any stored plan by its id.** `proposals.user_id` is not checked. Ids are random, and a plan holds no secret, but a plan should belong to someone before real money follows it.
9. **A vault cannot be made all cash after it is opened.** Both vaults take an empty list of targets and `buildCreateVault` passes one for a plan that is all cash, but the shared `Targets` type, which `buildSetTargets` takes, refuses an empty list.
10. **The legacy server-signing route.** `routes/monitor-rebalance.ts` (`POST /policies/:id/rebalance`) loads a keypair. It is behind `LEGACY_STRUCTURER`, which is off unless set: the file is then not loaded. The monitor's reads and its unsigned revoke are in `routes/monitor.ts`, sign nothing and are always served. The flag must never be on where the API is hosted.
11. **One real Privy identity token, read by a person.** The field names this code expects in `linked_accounts` (`type`, `address`, `chain_type`, `wallet_client_type`) and the `sid` claim of the access token come from Privy's documentation, not from a token. Decode one of each from the real app before sign-in is trusted. The person's chain now rests on `wallet_client_type` too: `privy` is a wallet made in the app, anything else an outside wallet.
12. **The consent route, the service key for the MCP server, and keyless order creation for agents** (design section 10).
13. **The order of targets an EVM vault wants.** `BasketVault.sol` takes its targets in ascending token order. The API hands an adapter the targets in the plan's order, by weight. The EVM adapter has to sort them, with the trades that go with them, before it builds; the mock takes any order.
