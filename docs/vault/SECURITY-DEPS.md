# SECURITY-DEPS.md: known advisories in what ships

*Recorded 2026-10-02 (FRAME-2). Accepted for now, so the audit check stays worth reading; SEC-4 in `STATE-VAULT.md` removes them.*

`pnpm audit --prod` reports five high advisories in the dependencies of the apps. Their ids are under `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`. With that list, `security.yml` passes on these five and fails on any other high or critical advisory. Its job summary still lists all of them, with these marked as accepted. Moderate and low advisories are listed and never fail the job.

| Advisory | Package, installed | Comes in through | What it is | Do we reach it | Fix |
|---|---|---|---|---|---|
| GHSA-rfgv-xxqx-mfg5 | `undici` 7.29.0 | `apps/api` and `apps/risk-api` > `@scalar/fastify-api-reference` > `@scalar/openapi-parser` > `@scalar/json-magic` | Denial of service through a WebSocket subprotocol the client did not ask for | No. `json-magic` takes only `fetch` and `Agent` from `undici`, in the plugin that loads a document from a URL. Both apps give the reference page the document `@fastify/swagger` builds in memory | 7.29.1. An override of `undici` to `>=7.29.1 <8` |
| GHSA-w293-vg96-wgc3 | `undici` 7.29.0 | The same | TLS certificate checks skipped when `BalancedPool` drops its connect options | No. Nothing here uses `BalancedPool` | The same override |
| GHSA-82x6-q7mm-w9cf | `toml` 3.0.0 | `packages/chain-solana` > `@kamino-finance/klend-sdk` > `@coral-xyz/anchor` 0.28 and 0.29 | Unbounded recursion while parsing | No. Anchor parses one file, a local `Anchor.toml`, in `workspace.js`. Neither `klend-sdk` nor our code calls it | 4.2.0, a major version up. The override needs a check that Anchor's `toml.parse` call still works |
| GHSA-v5mp-jgw5-2x6j | `toml` 3.0.0 | The same | Prototype pollution while parsing | No, for the same reason | 4.1.2, covered by the same override |
| GHSA-3gc7-fjrx-p6mg | `bigint-buffer` 1.1.5 | `packages/chain-solana` > `@kamino-finance/klend-sdk` > `@kamino-finance/farms-sdk` > `@kamino-finance/kliquidity-sdk` > `@orca-so/common-sdk` > `@solana/spl-token` > `@solana/buffer-layout-utils` | Buffer overflow in `toBigIntLE()` | It can be called: `buffer-layout-utils` uses it to decode 64-bit fields of account data. That data comes from our RPC, never from what a user sends | No fixed release exists. 1.1.5 is the latest on npm and the advisory names no patched version, though `pnpm audit` prints `>=1.1.6`. The override has to swap the package for a maintained one, or wait for `klend-sdk` to drop it |

When an override lands, its line leaves `pnpm-workspace.yaml` and its row leaves this table. A new advisory is never added here without a row that says why.

One high advisory is left out of this table and out of the accepted list on purpose (gate `AUDIT-BRACES`, Oct 3): GHSA-vfj7-8cjw-p6xm in `braces` 3.0.3 has no fixed release, and every path to it runs through React Native's bundler under the sign-in library, which the web build never loads, so the audit check stays red and a pull request may merge while that advisory is its only finding, until a fixed release is published and the override lands (SEC-4).

The Rust side is `deny.toml`: two "unmaintained" notices under `solana-program` are ignored there by id, each with its reason.
