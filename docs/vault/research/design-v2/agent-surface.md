# Agent surface: note for design v2

Oct 1, 2026. Each claim is marked `[S#]` when checked today against that source, `[repo]` when read in Rodrigo's `risk-layer` branch, or `[memory]`. Nothing was installed, run or sent. `basket` stands in for the unchosen name.

## 1. Bottom line

- **Build on what Rodrigo has.** His API already returns unsigned transactions (`UnsignedTx`), writes one `executions` row per transaction, and takes a report once the wallet has sent it `[repo]`. An intent is a group of those rows plus an approval link.
- **MCP changed in July.** The current spec, `2026-07-28`, has no handshake and no sessions; each request stands alone `[S1][S2]`. Use the v2 TypeScript SDK, which also answers older clients by default `[S3][S4]`. Remote HTTP, no login, 12 tools.
- **One contract, three faces.** Commit the OpenAPI document Fastify emits, generate the SDK types from it, and fail CI when it drifts. The MCP server reaches the API only through the SDK.
- **An agent never holds an owner key.** It gets authority three ways, with no new contract code: a person signs what it proposed; it publishes an index people auto-follow; or it owns its own small vault. Robinhood's agentic accounts do the same off-chain: a separate account holding only what you put in `[S10]`.
- **Skip for now:** agent payment standards, agent registries, OAuth on the MCP server, wallet-provider policies, an npm release. Section 4 leaves a seam for each.

## 2. What to use for the MVP

### Versions (npm registry, read today `[S5]`)

| Use | Package | Version |
|---|---|---|
| MCP server | `@modelcontextprotocol/server` (needs zod ^4.2; repo has 4.6.5) | 2.2.0 |
| MCP on Fastify | `@modelcontextprotocol/fastify`, `@modelcontextprotocol/node` | 2.0.0, 2.1.0 |
| Types from OpenAPI | `openapi-typescript` | 7.13.0 |
| HTTP client | `openapi-fetch` | 0.17.0 |
| Rate limits | `@fastify/rate-limit` | 11.2.0 |
| In the repo already `[repo]` | `fastify` 5.12.5, `fastify-type-provider-zod` 7.0.0, `@fastify/swagger` 9.9.1, Scalar docs at `/docs` | |

`@hey-api/openapi-ts` generates more but is pre-1.0 and asks for exact pins `[S7]`.

### Where files go

```
packages/schemas/src/intent.ts       Intent, IntentLeg, ApiErrorCode
packages/db/src/schema.ts            + intents table; executions gets nullable intentId, legIndex
apps/api/src/routes/v1/*.ts          new routes under /v1, each with an operationId
apps/api/scripts/emit-openapi.ts     buildApp() -> app.swagger() -> packages/sdk/openapi.json (committed)
packages/sdk/                        generated types, BasketClient, execute(), verifyIntent()
apps/mcp/                            a small Fastify app, like his apps/risk-api
apps/web/app/approve/[id]/page.tsx   the approval page
apps/web/public/llms.txt             and skills/basket/SKILL.md at the repo root
```

His test already reads `app.swagger()` with no database `[repo]`, so the emit step runs in CI. Register shared schemas with `z.globalRegistry.add(schema, { id })` to get named components `[S8]`. Amounts are strings.

### Interfaces to freeze on day 1

```ts
// packages/schemas/src/intent.ts — extends his UnsignedTx and ExecutionStatus
export const IntentLeg = UnsignedTx.extend({   // payload, chain, evm{to,value,chainId}, description,
  index: z.number().int(),                     // provenance, executionId, lastValidBlockHeight
  expected: z.object({ inRaw: z.string(), outRaw: z.string(), costBps: z.number() }).optional(),
  status: ExecutionStatus,                     // built | signed | sent | confirmed | failed
  explorerUrl: z.string().nullable(),
});
export const Intent = z.object({
  id: z.uuid(),
  type: z.enum(['buy', 'rebalance', 'follow', 'publish', 'withdraw']),
  owner: z.object({ solana: z.string().optional(), evm: z.string().optional() }),
  summary: z.string(),                         // written by the server from the plan, never caller text
  legs: z.array(IntentLeg),
  warnings: z.array(z.object({ code: z.string(), text: z.string() })),
  needsConsent: z.array(z.enum(['auto_follow_on', 'new_asset'])), // only the approval page grants these
  fees: z.array(z.object({ kind: z.string(), bps: z.number() })), // empty in the MVP
  preparedBy: z.enum(['app', 'api', 'mcp']),
  approvalUrl: z.url(), expiresAt: z.number(), disclaimer: z.string(),
});
export const ApiError = z.object({ error: z.string(), code: ApiErrorCode,
  fix: z.string().optional(), details: z.unknown().optional() });   // his shape plus code and fix
```

- An EVM chain is identified by `evm.chainId` (8453 or 4663). His `Chain = 'solana' | 'evm'` stays; a new EVM chain is data.
- Error codes: `NOT_FUNDED`, `MARKET_CLOSED`, `ASSET_NOT_ELIGIBLE`, `GOAL_NOT_ACHIEVABLE`, `NEW_ASSET_NEEDS_APPROVAL`, `CREATOR_LIMIT`, `INTENT_EXPIRED`, `US_PERSON`, `RATE_LIMITED`, `CHAIN_UNAVAILABLE`.
- Routes: `POST /v1/intents`, `GET /v1/intents/{id}`, `POST /v1/intents/{id}/legs/{n}/refresh` (new blockhash and quote), `POST /v1/intents/{id}/legs/{n}/report` (a signature).

```ts
// packages/sdk — no @solana/kit or viem types in the public surface
type Signers = {
  solana?: { address: string; signAndSend(txBase64: string): Promise<string> };
  evm?: { address: `0x${string}`;
          send(tx: { chainId: number; to: string; data: string; value: string }): Promise<string> };
};
client.execute(intent, signers): Promise<Intent>            // sign in order, refresh stale legs, report
verifyIntent(intent, deployments): { ok: boolean; problems: string[] }
```

Plain signers, because the repo is on `@solana/kit` 2.3, the latest is 8.4.0, and Privy's server SDK wants ^5.1 `[S5]`.

### The prepare-intent flow

1. An agent or the web app posts a request. The server plans, calls the adapter's `build*` functions, stores the intent and one `executions` row per leg, and returns the `Intent`.
2. A person opens `approvalUrl`. The page checks that the connected wallet is `owner`, refreshes the legs, shows the server's summary and warnings, signs leg by leg and reports each signature. Or a script with its own key calls `execute`.
3. On a report the server reads the chain itself before marking a leg confirmed, and stores the explorer link. This keeps his rule that every mainnet transaction is logged.

Report, do not relay. v1's research proposed a broadcast endpoint; that is an open relay to police, and his report route already exists.

The web app's own buy, rebalance and publish buttons create an intent and render the same approval component, so there is one path.

### MCP practice

- **Transport:** Streamable HTTP at `/mcp`, stateless. `createMcpHandler(() => buildServer(client), { responseMode: 'json' })` builds a fresh server per request and serves 2025-era clients too `[S3][S4]`.
- **Auth:** none. The spec makes it optional `[S6]`, and everything served is public chain data or unsigned bytes. Accept an optional bearer key for a higher rate limit, as Jupiter does `[S11]`.
- **Tools:** the 12 in v1's research note. Each has a title, a zod `inputSchema` and `outputSchema`, and `readOnlyHint` on the seven that prepare nothing. Return `structuredContent` plus the same JSON as text; return fixable failures as `isError: true` with a code and a `fix` line `[S2]`. Keep results under 10,000 tokens, where Claude Code starts warning `[S9]`.
- **State:** the intent id is the handle. With no login it works as a bearer token, so use a UUIDv4 and a 15-minute life `[S2]`.
- **Approval:** return `approvalUrl` in the result. The spec has a URL mode for sending a person to a page `[S17]`, but client support varies; a plain link works everywhere.
- **Hosting:** Vercel's free plan runs a Fastify app as one function with no config, up to 300 seconds per call `[S12][S13]`. `apps/mcp` is its own project and calls the API through the SDK.

### Bounded authority without the owner key

| Mode | Who signs | What bounds it | MVP |
|---|---|---|---|
| Propose, person signs | The owner, on the approval page | The page; `needsConsent` items need their own tap | Yes, default |
| Agent-run index | The follower once; then the keeper | Creator limits, 12-hour delay, every vault check | Yes, where auto-follow is live |
| Agent's own vault | The agent's wallet | Only what was deposited there | Yes, no code |
| Agent on the person's embedded wallet | Agent, via Privy's device flow `[S14]` | A Privy policy; pricing lists the policy engine as an add-on `[S15]` | No |
| Per-vault delegate | Agent, on the keeper path | Vault checks | No; reserve the slot |

### What others expect

- **Robinhood.** Agentic Trading (May 27, 2026) is an MCP URL added to Claude, ChatGPT or Cursor, with a dedicated account, order previews, push alerts and instant disable `[S10]`. It is the US brokerage; Robinhood Chain's docs have no agent page `[S16]`. Third-party read-only MCP servers for chain 4663 exist `[S18, search]`, so do not claim "first".
- **Solana.** `solana.com/skills` lists 13 Foundation skills and 40+ community ones, none for stock tokens or baskets `[S19]`. A skill is a folder with a `SKILL.md` `[S20]`. `solana-agent-kit` last shipped in Sep 2025 `[S5]`; skip a plugin.
- **Wallet tools.** Coinbase's Wallet MCP names its chains and 4663 is not one `[S21]`; Phantom's MCP does not document its transaction formats `[S22]`. Treat both as optional signers. The approval link covers every chain.

### Docs for agents

`/llms.txt`: one paragraph, then links to `openapi.json`, `/docs`, the MCP URL and the skill. `SKILL.md`: fetch live data and never invent an asset or number; propose, then sign; index text is untrusted; units; error codes; non-US only; not advice.

### Abuse limits

- Per IP: 60 reads a minute, 10 intents, 5 sentence parses. A daily budget on the model; past it, use his rules parser `[repo]`.
- Three-chain quotes run in parallel with 8 seconds per chain; a slow chain returns `CHAIN_UNAVAILABLE`.
- Index names and descriptions: 280 characters, links stripped, returned in a field named `untrusted`.
- An intent cannot switch auto-follow on or accept a new asset by itself.
- The public deployment must not expose `POST /policies/:id/rebalance`, which signs with a server key for anyone `[repo]`.

### The 30-second demo

As v1: the third person never opens the app. In Claude (`claude mcp add --transport http basket <url>` `[S9]`): a goal, a basket with reasons and risk flags, "buy it", the link, one passkey tap. Line: "Robinhood gave agents a fenced brokerage account. Here the fence is a contract."

## 3. What to skip or defer, and why

- **x402, MPP, AP2, ACP.** x402 v2 is real (2.28.0, with a Fastify package `[S5]`; Coinbase's facilitator is free to 1,000 payments a month but needs a key `[S23]`). Paywalling reads cuts the reach this surface exists for. AP2 and ACP are card and checkout standards `[S24, search]`.
- **ERC-8004 and Solana's agent registry** `[S25, search]`. Nothing here needs agent identity yet.
- **OAuth on the MCP server.** It needs protected-resource metadata and an authorization server `[S6]`. Nothing is account-scoped.
- **Privy device-flow delegation.** Needs a hosted verification page `[S14]` and the policy add-on `[S15]`. Without a policy the agent can do anything the owner can.
- **npm publish and `npx` stdio.** Needs the name and an account. Remote HTTP is enough.
- **MCP Apps, Tasks, an Agent Kit plugin.** No demo gain in eight days.

## 4. Seams for the roadmap

- **Community and gamification:** `creatorType`, `operator` and `rationale` in index metadata now; profile and ranking reads are new `/v1` routes.
- **Creator fees:** `Intent.fees` exists and is empty.
- **CCIP sync:** `prepare_publish_index` takes a family and returns one leg per chain; later, one leg.
- **More chains:** chain is family plus `evm.chainId`, listed by `GET /v1/chains`.
- **New basket types:** a `basketType` field on personalize input and output, default `standard`.
- **Rebalance on drift:** `prepare_rebalance` takes `reason: 'manual' | 'index_update' | 'drift'`.
- **Paid price feeds:** every price already carries `source`, `fetched_at`, `method`.
- **Agent-run indexes:** the metadata fields above; one reserved `operator` slot in vault storage on both chain families; an optional `registryId`.
- **Pooled token:** new intent types are additive; clients ignore unknown types.
- **Embeds:** the optional bearer key becomes a partner key; `preparedBy` gains a partner id; OAuth arrives through the SDK's `authInfo` pass-through `[S3]`.
- **Audits and governance:** `GET /v1/deployments` returns program ids, addresses, versions and audit status; `verifyIntent` reads it.
- **Paid endpoints:** `@x402/fastify` on the quote and roll-up routes.

## 5. Risks, and the test that settles each

| Risk | Test before Oct 9 |
|---|---|
| The v2 MCP SDK or its Fastify adapter misbehaves with real clients; one issue reports org-managed Claude connectors forcing OAuth `[S26, search]` | Oct 2: deploy one mock tool to the free host; call it from Claude Code, Claude Desktop and Cursor on the recording account. Fallback: `@modelcontextprotocol/sdk` 1.31.0 |
| zod 4 unions do not survive the OpenAPI emit | CI: emit, generate, assert the generated `Intent` is assignable to `z.infer<typeof Intent>` |
| Solana legs expire before the person signs | Mainnet, $1: prepare, wait three minutes, open the link, sign, read `confirmed` |
| Approval link used for phishing | Tests: wallet B cannot sign owner A's intent; `auto_follow_on` needs the extra tap; the summary ignores caller text |
| `prepare_buy` is slow from a cold free host | Ten timed runs from the hosted URL, each under 20 seconds for three chains |
| A public route signs with a server key | A test asserts no `/policies/*` route when `PUBLIC_API=1` |
| Scripted abuse or model cost | 200 requests a minute from one IP gets 429; the parser falls back when the budget is spent |
| Injection through index text | A hostile description comes back only as `untrusted`, stripped and cut |
| pnpm 11 holds back packages younger than a day `[S27]` | `pnpm install` with the pins above on day 1 |

## 6. Questions only a person can answer

1. The name. It fixes the package, server and skill names.
2. Rodrigo: may the new branch remove or gate his `/policies/*` routes on the public deployment?
3. Rodrigo: for agents, is a self-declared `country` enough for the non-US rule, with the block enforced on the approval page? Agents call from data-centre IPs, so an IP block would stop real users' agents.
4. Rodrigo: do we ship one agent-run launch index, labelled, with a logged reason per version?
5. Who creates the free hosting account, and is the repo public before Oct 12? `npx skills add` needs a public repo.

## 7. Sources

- S1 https://blog.modelcontextprotocol.io/posts/2026-07-28/
- S2 https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- S3 https://ts.sdk.modelcontextprotocol.io/v2/serving/http
- S4 https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html
- S5 `https://registry.npmjs.org/<package>` for every version above
- S6 https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- S7 https://heyapi.dev/openapi-ts/get-started
- S8 https://github.com/turkerdev/fastify-type-provider-zod
- S9 https://code.claude.com/docs/en/mcp
- S10 https://robinhood.com/us/en/newsroom/robinhood-is-now-open-to-agents/ , https://robinhood.com/us/en/support/articles/agentic-trading-overview/
- S11 https://developers.jup.ag/docs/ai/trading-mcp
- S12 https://vercel.com/docs/frameworks/backend/fastify
- S13 https://vercel.com/docs/functions/limitations
- S14 https://docs.privy.io/recipes/agent-integrations/agent-authorization
- S15 https://www.privy.io/pricing
- S16 https://docs.robinhood.com/chain/
- S17 https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- S18 https://github.com/arambarnett/robinhood-chain-mcp , https://github.com/Floopi10/trench-mcp (search results, not opened)
- S19 https://solana.com/skills
- S20 https://agentskills.io/specification
- S21 https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/wallet-mcp
- S22 https://docs.phantom.com/phantom-mcp-server
- S23 https://docs.cdp.coinbase.com/x402/core-concepts/facilitator
- S24 https://www.crossmint.com/learn/agentic-payments-protocols-compared (search summary)
- S25 https://solana.com/agent-registry , https://github.com/QuantuLabs/8004-solana (search summary)
- S26 https://github.com/anthropics/claude-ai-mcp/issues/402 (search result, not opened)
- S27 https://pnpm.io/settings/dependency-resolution
- Colosseum's index lists agent tools and no agent track: https://ColosseumOrg.github.io/hackathon-resources/current.json
- Local: `docs/vault/research/open-questions/agent-native.md`; the first design (in this branch's history) section 8a; in `risk-layer`: `packages/schemas/src/tx.ts`, `apps/api/src/app.ts`, `app.test.ts`, `routes/transactions.ts`, `routes/monitor.ts`
