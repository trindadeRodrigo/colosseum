# Agent surface: how AI agents use and integrate with the app

Oct 1, 2026. Docs, npm and public GitHub read today. Nothing was run, no accounts created, no spike code. Anything not confirmed in a primary source is marked [unverified]. `basket` below stands in for the unchosen product name.

## Answer

- **The design is already agent-shaped.** Every write in the chain adapter is a `build*` call that returns unsigned transactions, and the vault, not the caller, enforces the rules. That is the same pattern Jupiter's Trading MCP, Coinbase's Wallet MCP plugins and Glider's API use. The agent surface is four thin faces over one function, `prepareIntent`, about two agent-days as one extra stream.
- **Ship in the MVP:** a keyless REST API with an OpenAPI file, a typed SDK, a remote MCP server with 12 tools, an approval page in the web app, a `SKILL.md` and an `llms.txt`.
- **How an agent acts for a person:** it proposes, the person signs. Every write tool returns unsigned transactions plus an approval link to the app. No tool ever takes a key and the backend never signs for a user.
- **The scoped permission for agents is auto-follow itself.** An agent that wants to manage money for others publishes an index. People follow it with auto-follow, and the vault's existing rules (accepted assets only, delay, price check, weekly loss cap, in-kind exit) bound it. The agent's key controls a recipe, never funds. No new contract code.
- **Agents can publish and run community indexes** under the same creator limits as people, labelled as agent-run, with a reason logged per version.
- **x402: not in the MVP.** Reads stay free. One metered endpoint is a half-day stretch after integration, worth it only for the Solana Foundation's agentic-payments push and a Pay.sh listing.

## 1. What works in 2026

| Product | What it exposes | How signing works | Source |
|---|---|---|---|
| Jupiter | `llms.txt`, a docs MCP, 4 skills (`npx skills add jup-ag/agent-skills`), a JSON-native CLI, and a hosted Trading MCP at `https://mcp.jup.ag` with 75 tools | Keyless, optional API key for rate limit. Returns **unsigned transactions**; the client's wallet signs | [developers.jup.ag/docs/ai](https://developers.jup.ag/docs/ai), [trading-mcp](https://developers.jup.ag/docs/ai/trading-mcp) |
| Coinbase Wallet MCP (was Base MCP) | Remote MCP at `https://mcp.base.org`: `get_portfolio`, `send`, `swap`, `send_calls`, `sign`, x402 tools, `get_request_status` | Every write returns an **approval URL and a request id**; the person approves in their wallet and the agent polls. Third parties integrate with a markdown plugin: read endpoints, prepare endpoints that return unsigned calldata, and the mapping to `send_calls` | [docs.cdp.coinbase.com](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/wallet-mcp) |
| Phantom MCP | `npx -y @phantom/mcp-server@latest` (1.2.8), no App ID needed. `send_solana_transaction`, `send_evm_transaction`, `simulate_transaction`, `portfolio_rebalance`, `pay_api_access` | Device-code sign-in to a dedicated agent wallet; Phantom's KMS enforces policy and signs | [docs.phantom.com/phantom-mcp-server](https://docs.phantom.com/phantom-mcp-server) |
| Cesto | Keyless browser reads (`@cesto/sdk/client`), Web SDK, Server SDK (`@cesto/sdk` 0.6.0), two skills (`npx skills add cesto-co/cesto-skills`). No MCP server found | Partner path is **custodial**: Cesto provisions a Privy wallet per user and signs server-side. Keys are issued by hand, no self-serve | [docs.cesto.co/llms-full.txt](https://docs.cesto.co/llms-full.txt), [repo](https://github.com/cesto-co/cesto-skills) |
| Glider | REST v2 with an OpenAPI 3.1 file and two `llms.txt` files. Strategies, portfolios, positions, async operations | Tenant API keys. Two-stage writes: the API returns typed data, the user signs, the client submits. Session keys for automation | [docs.glider.fi](https://docs.glider.fi/api-reference/v2-overview) |
| Peaks | No public API, SDK, MCP or skill found (search only) [unverified] | Agent trades inside Peaks under risk presets | an internal team note |
| Privy | Agent wallets with policies; OAuth device flow so an outside agent can use a user's wallet (15-minute access token, 30-day refresh, revocable); `@privy-io/agent-wallet-cli` 0.3.6. Publishes a recipe for a robo-adviser agent **on Robinhood Chain 4663** | Keys in an enclave; the policy engine checks before signing. The app must host the verification page | [agent-authorization](https://docs.privy.io/recipes/agent-integrations/agent-authorization), [robo-advisor](https://docs.privy.io/recipes/agent-integrations/robo-advisor-agent) |
| Coinbase Agentic Wallets | `npx awal`, skills (authenticate, fund, send, trade, earn), session caps, per-transaction limits, x402 Bazaar search | Agent owns an MPC wallet under operator-set caps | [coinbase.com](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets) (search summary) |
| Turnkey | Agent skills repo ([tkhq/turnkey-agent-skills](https://github.com/tkhq/turnkey-agent-skills)); policies on EVM `to`/selector/chain and on Solana instruction data and accounts | Delegated API user under policy | [docs.turnkey.com](https://docs.turnkey.com/concepts/policies/examples/solana) (search summary) |
| Swig | 18 role actions: token and SOL limits (total, recurring, per destination), `program` (one named program), sub-accounts, x402 payer | Onchain roles. Nothing checks price or swap output, as the vault memo already found | [permissions](https://build.onswig.com/developer-sdk/permissions.md) |

Skills and registries:

- A skill is a folder with a `SKILL.md` whose frontmatter is `name` and `description`, installed with `npx skills add <owner>/<repo>` (`skills` 1.7.0). Colosseum's own skill is a 2-field frontmatter plus instructions to fetch a live JSON and refuse to invent entries ([SKILL.md](https://github.com/ColosseumOrg/colosseum-resources/blob/main/skills/colosseum-resources/SKILL.md)). Cesto's ships Python scripts and an API reference beside it.
- [solana.com/skills](https://solana.com/skills) lists the Foundation skill and about 40 community skills (Jupiter, Raydium, Kamino, Pyth, Helius, DFlow and others). No tokenized-stock or basket skill was seen. The page does not say how to submit one [unverified].
- Pay.sh: the `pay` CLI pays x402 and MPP challenges from a local wallet and has its own MCP mode with payment permissions. The paid-API catalog is the open [`pay-skills`](https://github.com/solana-foundation/pay-skills) repo and takes PRs ([README](https://github.com/solana-foundation/pay)).
- x402 packages are at 2.28.0 (`@x402/core`, `/next`, `/hono`, `/express`, `/svm`, `/evm`, `/fetch`, `/mcp`), published Sep 29. Headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` ([Solana guide](https://solana.com/docs/payments/agentic-payments/intro-to-x402)). CDP facilitator: 1,000 settlements a month free, then $0.001, `exact` only on Solana ([docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator), search summary). MPP: `@solana/mpp` 0.7.0, `mppx` 0.12.0.
- MCP spec `2026-07-28` made the core stateless (no handshake, no session), so a remote server is a plain HTTP route behind any host ([blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)). `@modelcontextprotocol/sdk` is 1.31.0 and `mcp-handler` (Next.js route) is 2.2.0. Which SDK version maps to that spec was not checked [unverified].

What to copy: unsigned transactions out (Jupiter), an approval link plus a status poll (Wallet MCP), keyless reads (Cesto), an OpenAPI file and `llms.txt` (Glider), a short skill that fetches live data and refuses to invent (Colosseum). What to avoid: Cesto's custodial partner wallets, and 75 tools.

## 2. The surface

One function in `packages/core`, `prepareIntent(adapters, request)`, used by the web app, the API and the MCP server. It runs the planner and the adapter's `build*` calls and returns an `Intent`. One code path means the agent surface cannot drift from the app.

```ts
type Intent = {
  id: string;
  type: 'buy' | 'rebalance' | 'follow' | 'set_auto_follow' | 'publish' | 'withdraw';
  owner: { solana?: Address; evm?: Address };
  summary: string;            // one paragraph a person can approve
  legs: Leg[];                // ordered within a chain; chains are independent
  warnings: Flag[];           // market closed, new asset, exit cost, unaudited
  approvalUrl: string;        // app page: review and sign with your own wallet
  expiresAt: number;
};
type Leg = {
  chain: ChainId; index: number; description: string;
  expected: { in: Amount; out: Amount; costBps: number };
  tx: { format: 'solana-v0-base64'; data: string }
    | { format: 'evm-calls'; chainId: number; calls: { to: Hex; data: Hex; value: Hex }[] };
  status: 'prepared' | 'submitted' | 'confirmed' | 'failed'; txId?: string;
};
```

The EVM shape is exactly what Wallet MCP's `send_calls` and viem take. Solana legs expire with their blockhash, so the intent stores the plan and the bytes are rebuilt on request or on the approval page.

### REST (`apps/api`, `/v1`)

Keyless and CORS-open. Nothing here is account-scoped: reads are public chain data, and an unsigned transaction is useless without the owner's signature. Rate limit by IP.

| Method | Path | Returns |
|---|---|---|
| GET | `/assets?chain=`, `/assets/{id}/risk` | Platform list; the risk sheet |
| GET | `/indexes`, `/indexes/{family}`, `/recipes/{id}?version=` | Shelf, per-chain recipes, versions, followers, creator, `creatorType` |
| GET | `/recipes/{id}/risk?sizeUsd=` | Roll-up: concentration, exit cost at that size, flags |
| POST | `/baskets/personalize` | Recipes per chain, explanation lines, the five-field card, the income verdict |
| POST | `/quotes` | Per-leg output and cost, market open or closed, funding check per chain |
| GET | `/portfolio?solana=&evm=` | Vaults, holdings, drift, pending index versions |
| POST | `/intents` | An `Intent` |
| GET | `/intents/{id}` | Status per leg |
| POST | `/intents/{id}/legs/{n}/broadcast` | Relays a signed transaction and tracks it, so an agent needs no RPC on three chains |
| GET | `/openapi.json`, `/llms.txt` | Generated from the zod schemas in `core` |

Index metadata needs no login either: the registry's `RecipePublished(id, version, hash, effectiveAt)` hash should cover the metadata, and the API shows metadata only once a matching onchain event exists.

Errors are typed and say how to fix them: `NOT_FUNDED` (token, chain, shortfall), `MARKET_CLOSED` (reopens at), `ASSET_NOT_ELIGIBLE`, `GOAL_NOT_ACHIEVABLE` (gap and options), `NEW_ASSET_NEEDS_APPROVAL`, `INTENT_EXPIRED`, `US_PERSON`.

### SDK (`packages/sdk`)

- Re-exports the `core` types and zod schemas. A `BasketClient` over the REST API.
- `execute(intent, { solana?, evm? })` signs legs in order with a `@solana/kit` or viem signer, re-prepares expired legs and tracks them.
- `verifyIntent(intent)` decodes every transaction locally and checks that it only touches the published program id, factory, vault and registry addresses. An agent does not have to trust the API.

### MCP server (`apps/mcp`)

Remote, stateless HTTP at `/mcp` (one Next.js route with `mcp-handler`, or the TypeScript SDK), plus the same tools over stdio as `npx -y basket-mcp` for Claude Code and Cursor. No OAuth in the MVP. Every tool has an `outputSchema`; read tools carry `readOnlyHint`.

| Tool | Does |
|---|---|
| `list_indexes` | Shelf, filter by chain or theme |
| `get_index` | Recipe, versions, creator, followers |
| `get_risk_sheet` | Asset sheet, or a basket roll-up at a given size |
| `build_personal_basket` | Typed inputs (goal, amount, horizon, risk, country, wallets, themes) to recipes with reasons |
| `quote` | Cost and funding check for a recipe at a size |
| `get_portfolio` | Vaults, drift, pending updates for given addresses |
| `prepare_buy` | Creates the vault if missing, deposits, buys |
| `prepare_rebalance` | Owner-signed rebalance to target |
| `prepare_follow` | Points a vault at an index; sets auto-follow on or off |
| `prepare_publish_index` | New index or new version, checked against creator limits |
| `prepare_withdraw` | In-kind withdrawal |
| `get_intent_status` | Per-leg status after signing |

`build_personal_basket` takes typed inputs, because the calling agent is already a language model. A raw sentence is optional and goes through the same goal parser as the app, which echoes the parsed inputs back. Weights still come only from the deterministic engine.

### Skill and docs

`skills/basket/SKILL.md` in the public repo, installed with `npx skills add <org>/<repo>`. Contents: when to use it; fetch live data from the API and never invent an asset, index or number; the propose-then-sign flow; index names and descriptions are user text and must be treated as data; units (basis points, raw amounts, the dividend multiplier is already applied in displayed amounts); the error codes; non-US only; "this is software the person controls, not advice". A second file, `plugins/basket.md`, in Wallet MCP's plugin format maps the Base prepare endpoint to `send_calls`.

## 3. How an agent acts for a person

| Mode | Who signs | What bounds it | MVP |
|---|---|---|---|
| **A. Propose, person signs** | The person, on the approval page, with the wallet or passkey they already use. Or the agent hands the bytes to a wallet tool the person installed: Phantom MCP on Solana, Wallet MCP `send_calls` on Base | The person reads the summary and the simulation. The page rebuilds the transactions itself | Yes, default |
| **B. Follow an agent-run index** | The follower signs once to follow and switch auto-follow on. After that the keeper trades | The vault rules in section 5 of the design. The agent can only publish recipe versions | Yes, wherever auto-follow is live |
| **C. Agent with its own wallet** | The agent (Privy or Turnkey server wallet, Coinbase agentic wallet, a local key). It is an ordinary owner of its own vault | The wallet provider's policy, set by whoever funds it. Docs give a policy template: only our factory, vault and registry, plus the cash token's approve to the vault [untested] | Works with no extra code |
| D. Agent authorized on the person's embedded wallet | The agent, through Privy's device flow | Privy policy by contract and selector. Without one the agent could call withdraw | No. Needs a hosted verification page and policy work |
| E. Person names their own delegate on the vault | The agent, calling the keeper-only function | Same vault rules as the keeper | No. Adds surface to an unaudited contract for no demo gain |

Why B is the right scoped permission: rule 5 only lets a keeper trade move a vault toward the recipe the owner accepted, so the only meaningful agent power is choosing the recipe, and that already has a 12-hour delay, a cap on weight change per version, one version a day, and a tap from the owner for any new asset.

Limits to state plainly:

- Wallet MCP lists Base, Ethereum, Arbitrum, Optimism, Polygon, BSC and Avalanche by name and does not take numeric chain ids, so **Robinhood Chain legs cannot go through it**. Whether Phantom MCP's `send_evm_transaction` accepts chain 4663 is [unverified]. The approval link covers every chain.
- The geofence is on the web app. MCP calls arrive from data-centre IPs, often in the US, so an IP block on the API would stop real users' agents and stop nobody else. Mode A enforces the block at signing, on the approval page. Mode C cannot be enforced: `country` is a required, self-declared input and US returns `US_PERSON`. This needs a decision from Rodrigo.
- Index names and descriptions are an injection path into any agent that reads the shelf. Cap length, strip links and markup, return them in a field named as untrusted, and say so in the skill.

## 4. Agents publishing and running indexes

Yes. Publishing is a signature, so any agent with a wallet is a creator, and the registry cannot tell the difference. What to add:

- `creatorType: 'person' | 'agent'` and an `operator` in the off-chain metadata, shown on the shelf. Self-declared.
- A `rationale` string per version, stored with the metadata, so every change has a public reason.
- The registry is permissionless but the shelf is ours: new indexes stay unranked until they have followers. A publish fee is a later anti-spam option.
- One launch index run by an agent: a daily script holding a key and calling `prepare_publish_index` under a published rule, with a model writing the rationale and never the weights. Half a day, and it is the cheapest proof of the claim.

Open for Rodrigo: an agent-run index that people auto-follow has the same portfolio-management look as a human one. The label and the logged reasons help; they do not settle it.

## 5. Paid endpoints (x402)

Not in the MVP.

- The evidence is against a paywall as a pitch. On Base in August most x402 volume was one wallet looping and the median seller made $2.50 a month (an internal team note). "The x402 directory shape has lost before" (`report.md`). Paywalling reads would also cut the distribution the agent surface is for.
- The one place a charge has a reason: basket risk roll-ups at an arbitrary size cost us live quotes on three chains. Past a free daily quota, return 402 at about $0.01 in USDC on Solana or Base. Phantom's MCP already has this shape (`pay_api_access` when a quota runs out).
- Cost: `@x402/next` or `@x402/hono` on one route, half a day. It needs a receiving address and, for the CDP facilitator, an API key, both from a person. Then a PR to `pay-skills` lists it in Pay.sh.
- Do it only if a day is free after Oct 8. It speaks to the Solana Foundation's agentic-payments push and to nobody else. Skip MPP.

## 6. What is cheap enough for the MVP

To freeze on day 1, at no build cost:

1. Zod schemas in `core` for `Recipe`, the personalization input and output, `RiskSheet`, `Quote`, `Intent`. OpenAPI and MCP tool schemas are generated from them.
2. `Tx` is serializable: base64 v0 on Solana, `{chainId, to, data, value}` on EVM.
3. `prepareIntent` lives in `core`; the web app's buy, rebalance, follow and publish screens call it too.
4. The registry hash covers the index metadata.
5. The error-code list.

New stream K, about two agent-days, against the mock adapter from day 2:

| Piece | Effort |
|---|---|
| REST prepare endpoints, broadcast relay, `openapi.json` (extends stream G) | 0.5 day |
| `packages/sdk` with `execute` and `verifyIntent` | 0.5 day |
| `apps/mcp`, remote and stdio | 0.5 day |
| Approval page `/approve/[intentId]` (reuses the confirm screens from stream H) | 0.5 day |
| `SKILL.md`, `llms.txt`, Wallet MCP plugin file | 2 hours |
| Done when: a script acting as an MCP client goes goal, basket, risk sheet, quote, `prepare_buy`, signs with a test key, and reads `confirmed` on each chain | |

Stretch, in order: the agent-run launch index; the x402 route and Pay.sh listing; PRs to the solana.com skills page and Coinbase's skills repo.

Not now: OAuth on the MCP server, Privy device-flow delegation, a per-vault delegate, MCP Apps widgets, MPP, managed wallets for partners.

Needs a person: an npm account to publish the SDK and the stdio server; a public GitHub repo for `npx skills add`; a public HTTPS URL for `/mcp`; the name, which fixes every package name; the geofence and agent-index calls in sections 3 and 4.

## 7. The 30-second beat

Make the third of the "three people, three baskets" the one who never opens the app. It costs no extra demo time.

1. In Claude with the MCP server connected: "I have $2,000, I need it in 18 months, keep it safe. Build me a basket and tell me what could go wrong." (5s)
2. The agent calls `build_personal_basket` and `get_risk_sheet`. The basket appears with a reason per line and the top two risk flags. (10s)
3. "Buy it." The agent calls `prepare_buy` and returns the approval link. (5s)
4. The link opens the app: three chains, cost per leg, one passkey tap, legs settle. (10s)

Voice-over: "The agent proposed. She signed. The vault checks the rest." If there is room in the auto-follow segment, show the agent-run index publishing a version and a keeper trade outside the recipe being rejected.

Record it in Claude Desktop or Claude Code against the hosted URL. Rehearse the Solana legs, since they expire in about a minute.

## Not verified

- Nothing was executed. A read-only `tools/list` call to `mcp.jup.ag` returned an empty body from this machine, so Jupiter's tool shapes are from its docs.
- Peaks having no developer surface, the solana.com skills submission path, and Coinbase Agentic Wallets and Turnkey details are from search summaries.
- Privy and Turnkey policy templates for mode C are untested, and Privy's policy engine may be a paid add-on (`wallet-providers.md`).
