# Spike: PDA vault buys SPYx through Jupiter by CPI

Throwaway code, Oct 1, 2026. Not the product's vault: no recipe, keeper, oracle or loss cap.

**Question.** Can a program-owned vault on Solana buy a Token-2022 stock token (SPYx, `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`) with USDC through Jupiter by CPI, checking its own balances before and after?

**Answer.** Yes on a local validator running mainnet's Jupiter, Raydium CLMM, pool and mint state. Not yet run on mainnet; that needs a funded wallet (steps below).

## What is here

| Path | What |
|---|---|
| `programs/vault-swap/src/lib.rs` | Anchor 0.31.1 program, 236 lines. `create_vault`, `swap`, `withdraw` |
| `target/idl/vault_swap.json` | IDL. Program id `78mDDDYW2yEz9qmNeLbgCAcsKH7CrqmYDPtNUpVhUHic` (keypair in `keys/`) |
| `scripts/common.ts` | Jupiter quote + swap-instructions with the vault PDA as `userPublicKey`; wraps them in the vault's `swap`; builds the v0 transaction |
| `scripts/prepare-local.ts` | Freezes one route, lists the mainnet accounts it touches, writes `out/start-validator.sh` |
| `scripts/run-swap.ts` | Create vault, fund, swap. Local by default; mainnet simulates unless `--send` |
| `scripts/adversarial.ts` | Three calls that must fail (local) |
| `scripts/withdraw.ts` | Owner withdraws in kind |
| `scripts/measure-routes.ts` | Read-only: transaction size and account count for several Jupiter settings |
| `out/report-*.json` | Raw results of every run below, with full logs |

`swap(max_in, min_out, data)` forwards Jupiter's instruction bytes and `remaining_accounts` with `invoke_signed`, signing as the vault PDA. Around the CPI it:

- reads the vault's input and output token accounts before and after, and requires `spent <= max_in` and `received >= min_out` (it ignores Jupiter's own numbers);
- snapshots every other writable token account owned by the vault in the account list and requires none decreased;
- requires owner unchanged and no delegate or close authority on the two accounts afterwards;
- only calls `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`; only the vault's owner may call it.

The vault is one PDA that both stores state and signs. Seeds: `["vault", owner, basket_id as u64 LE]`.

## What was run and what happened

Tools: anchor-cli 0.31.1, solana-cli 3.0.1, node 24. Jupiter API `https://lite-api.jup.ag/swap/v1` (no key).

**Build.** `anchor build` with the default platform-tools (v1.51, rustc 1.84) fails: `block-buffer 0.12.1` (pulled by `blake3 1.8.7`) needs edition 2024. `anchor build --no-idl -- --tools-version v1.54` works (v1.54 was already in `~/.cache/solana`). IDL built separately with `anchor idl build`. `anchor-lang` is pinned to `=0.31.1`; unpinned, cargo picks 0.31.2. Binary: 248,904 bytes. Solana MCP `program_autofixer`: no issues.

**Local validator.** `solana-test-validator --warp-slot <mainnet slot> --clone-upgradeable-program` (Jupiter, Raydium CLMM) plus `--clone` for 13 accounts (both mints, pool, tick arrays, lookup table and so on). The vault's 20 USDC is a made-up token account loaded with `--account`. Start-up took about 5 seconds against the public RPC. The validator's built-in Token-2022 handled SPYx's extensions without cloning.

| Run | Jupiter instruction | Jupiter accounts | Tx accounts | Tx bytes | Compute units | Deepest invoke | Result |
|---|---|---|---|---|---|---|---|
| Raydium CLMM, direct | `route` | 28 | 23 | 611 | 83,404 | 4 | 10 USDC → 1,301,508 raw SPYx (quote 1,301,487, min 1,288,473) |
| Raydium CLMM, `useSharedAccounts=true` | `shared_accounts_route` | 32 | 26 | 712 | 96,575 | 4 | 10 USDC → 1,301,785 raw SPYx |
| Riptide (Jupiter's pick), shared accounts | `shared_accounts_route` | 27 | 22 | 611 | n/a | n/a | Fails inside Riptide: `Oracle data is invalid`. The vault-signed USDC transfer before it succeeded |
| Riptide → Whirlpool via a second stock token (Jupiter's default at that moment) | `route` | 39 | 29 | 607 | n/a | n/a | Fails in Jupiter: 6025 `InvalidTokenAccount`. The route needs the vault to hold an account for the intermediate mint |
| Mainnet flow rehearsed locally: deposit, swap, withdraw | `route` | 28 | 23 | 623 | 82,153 | 4 | Owner ends with 10 USDC and 1,301,306 raw SPYx |

- Invoke chain: vault program [1] → Jupiter [2] → Raydium CLMM [3] → Token / Token-2022 [4]. Mainnet's limit is 5: `solana feature status -um` shows "SIMD-0296: Raise CPI nesting limit from 4 to 8" inactive. One level is spare.
- The vault program's own cost is about 20,000 units (83,254 total minus Jupiter's 63,190).
- Other transactions: create vault and its token accounts 38,041 units (60,505 with the USDC deposit); withdraw one token 30,932 units.
- Riptide is a proprietary market maker that needs a live oracle, so it cannot be replayed from a snapshot. Local tests need `dexes=Raydium CLMM` (or another plain AMM).

**Calls that must fail (local, simulated).**

| Case | Result |
|---|---|
| `min_out` set to twice the quote | `ReceivedTooLittle`. Jupiter itself succeeded |
| Vault's SPYx account replaced by an attacker's everywhere in Jupiter's account list | `ReceivedTooLittle`. Jupiter itself succeeded and would have paid the attacker |
| Caller is not the owner | Anchor `ConstraintHasOne` |

Not exercised: `OtherAccountDebited` and `AccountTampered` (no route was built that triggers them).

**Mainnet sizes, built but never sent** (`scripts/measure-routes.ts`, routes change minute to minute):

| Leg | Route | Jupiter accounts | Tx accounts | Tx bytes | Lookup tables |
|---|---|---|---|---|---|
| $10, default | Riptide, or PancakeSwap | 23–28 | 19–23 | 522–592 | 1 |
| $10, shared accounts | Whirlpool | 29 | 24 | 690 | 1 |
| $1k, default | Riptide, or Byreal | 23–28 | 19–23 | 522–623 | 1 |
| $50k, default | Raydium CLMM ×2 + Riptide | 61 | 38 | 841 | 3 |
| $50k, `maxAccounts=30` | Raydium CLMM + Riptide | 42 | 29 | 682 | 2 |

Limits are 64 accounts and 1,232 bytes. The keyless Jupiter endpoint returned 429 after a handful of calls in a minute; the scripts retry every 10 seconds and accept `JUP_API_KEY`.

## Run it locally again

```sh
cd spikes/solana-vault-swap
pnpm install --ignore-workspace
anchor build --no-idl -- --tools-version v1.54        # only if the program changed
anchor idl build -o target/idl/vault_swap.json        # only if the program changed
pnpm prepare-local                                    # reads mainnet, writes out/route.json and out/start-validator.sh
./out/start-validator.sh &                            # port 8899
pnpm swap                                             # prints JSON; full logs in out/report-local.json
pnpm tsx scripts/adversarial.ts                       # needs 10 USDC still in the vault, so run before withdraw
pnpm withdraw
```

`prepare-local` options: `DEXES="Raydium CLMM"` (default), `DIRECT=0`, `SHARED=1`, `MAX_ACCOUNTS=30`, `AMOUNT=10000000`, `FUND=owner` (puts the made-up USDC in the owner's wallet so the mainnet flow can be rehearsed with `CLUSTER=mainnet RPC_URL=http://127.0.0.1:8899 OWNER_KEYPAIR=keys/local-owner.json`).

Building with `--tools-version` changes which toolchain rustup links as the Solana one. It was v1.54 before this spike and is v1.54 now.

## Mainnet test with about $10

Only Thom can run this: it deploys a program and signs with a funded key.

Needs: a fresh keypair holding about 1.4 SOL and 12 USDC, and a mainnet RPC that accepts sends (the public one is too slow for a deploy). Of the SOL, 1.265 is program rent (`solana rent 248904 -um`) and comes back in step 6. About 0.006 SOL of account rent stays behind; the spike has no close instruction.

```sh
cd spikes/solana-vault-swap
export RPC_URL=<mainnet RPC>
export OWNER_KEYPAIR=<path to the funded keypair>

# 1. Deploy. The program id must print as 78mDDDYW2yEz9qmNeLbgCAcsKH7CrqmYDPtNUpVhUHic.
solana-keygen pubkey keys/program-keypair.json
solana program deploy target/deploy/vault_swap.so --program-id keys/program-keypair.json \
  -u $RPC_URL -k $OWNER_KEYPAIR --with-compute-unit-price 50000 --max-sign-attempts 20

# 2. Dry run. Sends nothing. Expect "setup": { "simulated": "ok" }.
CLUSTER=mainnet pnpm swap

# 3. Create the vault, deposit 10 USDC, swap through the pool that was tested locally.
CLUSTER=mainnet DEXES="Raydium CLMM" pnpm swap --send

# 4. Optional, 2 USDC more: let Jupiter pick the pool. It usually picks a proprietary market
#    maker, which could not be tested locally.
CLUSTER=mainnet AMOUNT=2000000 pnpm swap --send

# 5. Take everything back out.
CLUSTER=mainnet pnpm withdraw --send

# 6. Recover the program rent. The program id cannot be reused afterwards.
solana program close 78mDDDYW2yEz9qmNeLbgCAcsKH7CrqmYDPtNUpVhUHic -u $RPC_URL -k $OWNER_KEYPAIR --bypass-warning
```

Success in step 3:

- `"swap": { "err": null }` and a signature that opens on solscan.io.
- `vaultBalances.after.spyx` is at least `route.minOut` (about 1,300,000 raw units, 0.013 SPYx, for 10 USDC) and `after.usdc` dropped by 10,000,000.
- The log has `vault swap: spent=10000000 received=...`.
- Write down `tx.txBytes`, `tx.accountsTotal`, `swap.computeUnitsConsumed`, `swap.maxInvokeDepth`. Expect roughly 600 bytes, 23 accounts, 85,000 units, depth 4. They land in `out/report-mainnet.json`.

Success in step 5: the wallet shows SPYx. Wallets display the raw amount times the dividend multiplier (1.0057), so 1,301,306 raw shows as about 0.01309.

If it fails:

- `ReceivedTooLittle` (6002): price moved more than 1% between quote and send. Run again, or `SLIPPAGE_BPS=200`.
- Jupiter 6025, or the script's "route needs an intermediate token account": keep `DIRECT=1` (default) or set `SHARED=1`.
- An error from inside a market maker in step 4 (stale quote): run again.
- Deploy stalls: `solana program show --buffers -k $OWNER_KEYPAIR -u $RPC_URL`, then rerun the deploy with `--buffer <address>`, or `solana program close --buffers` to get the SOL back.

## Not covered

- Any real mainnet execution.
- Compute units and depth for proprietary market makers and for the three-way $50k split.
- Jupiter's `route_v2` / `shared_accounts_route_v2` (in the on-chain IDL; the API returned the v1 instructions).
- Whether mainnet's Token-2022 build matches the local validator's.
- Keeper role, oracle price check, loss cap, recipe allowlist.
