# spike: evm-vault (throwaway)

Question: can a contract vault hold and trade stock tokens on Robinhood Chain (4663) and Base (8453)?
Answer: yes on both. Run 2026-10-01, about 13:40-14:30 UTC (US market open). Nothing was signed or sent to a real chain.

The results are summarised in `docs/vault/DESIGN-VAULT.md`.

## What is here

| File | What |
|---|---|
| `src/BasketVault.sol` | Spike vault. Owner: `deposit`, `withdraw`, `withdrawAll` (in kind). Keeper: `keeperSwap(router, tokenIn, tokenOut, amountIn, minOut, data)` with allowlisted router, exact approval (direct or via Permit2) zeroed after, own-balance deltas, Chainlink value invariant (`maxLossBps`), feed staleness. No clones, cooldown, weekly cap, market-hours gate or target-weight check. |
| `src/UniV4Calldata.sol` | Builds Universal Router calldata for a single-pool v4 exact-in swap. |
| `src/SlipstreamAdapter.sol` | 40-line stand-in router for one Aerodrome Slipstream pool (Base only). |
| `src/BaseSim.sol` + `script/base-sim.sh` | Whole vault flow on Base in one read-only `eth_call` with state overrides. |
| `test/RobinhoodFork.t.sol` | 10 fork tests against Robinhood Chain. |
| `test/BaseFork.t.sol` | Shows a Foundry fork cannot execute B20 tokens. |
| `script/TenDollar.s.sol` | forge script, $10 real test. Works for Robinhood Chain only. |
| `script/ten-dollar-cast.sh` | Same five transactions with `forge create` + `cast send`. Works for both chains; the only way on Base. |
| `evidence/` | Raw outputs of the runs below, pinned block numbers, the 182 USDG/NVDA v4 pools. |

## What was run and what happened

Robinhood Chain, anvil fork at block 77417307 (`anvil --fork-url https://robinhood.drpc.org --fork-block-number 77417307 --port 8546 --chain-id 4663 --auto-impersonate`):

```
forge test --match-contract RobinhoodFork --fork-url http://127.0.0.1:8546 -vv     # 10 passed
forge script script/TenDollar.s.sol --rpc-url http://127.0.0.1:8546 --unlocked --sender 0xfbcC34e25937282a3D0FbDE054A9A49E9968c51A --broadcast --slow   # 5 txs ok on the fork
RPC=http://127.0.0.1:8546 SIGNER="--unlocked --from 0xfbcC…c51A" ./script/ten-dollar-cast.sh rh   # 4 txs + deploy ok on the fork
```

- Vault received 0.05 NVDA from an impersonated holder, held it, sent it to a fresh EOA and back to the owner. No transfer-time gate.
- Keeper swap 10 USDG -> 0.04328 NVDA through Universal Router 2.1.2 and the hookless 0.01% v4 pool. 295,659 gas for the transaction (238,718 inside the call).
- Reverts as designed: output sent to the keeper, a 90%-fee pool, non-keeper caller, non-owner withdraw, unlisted router.
- The official RPC returned Cloudflare 403 after about 45 calls; dRPC's public endpoint served the pinned block.

Base:

```
anvil --fork-url https://mainnet.base.org --port 8547     # then any call to NVDAc: "EVM error OpcodeNotFound"
BASE_RPC_URL=https://mainnet.base.org forge test --match-contract BaseFork -vv     # passes, i.e. confirms the failure
forge script script/TenDollar.s.sol --rpc-url https://mainnet.base.org --sender 0x…bEEF   # fails at NVDAc.decimals()
./script/base-sim.sh                                    # read-only eth_call, whole flow succeeds
RPC=https://mainnet.base.org SIGNER="--from 0x…bEEF" DRY=1 ./script/ten-dollar-cast.sh base   # prints the plan only
```

- `base-sim.sh`: a vault created inside the call deposited 10 USDC, swapped to 0.04330827 NVDAc on the Aerodrome pool, passed the Chainlink check, and withdrew in kind to another address. 267,603 gas inside `keeperSwap`.

## Not run

- Any real transaction on either mainnet.
- `base-forge` / `anvil --base` from github.com/base/base-anvil (Base's Foundry fork that hosts the precompiles). Not installed here.

## The $10 test (Thom)

Needs a funded non-US wallet in a Foundry keystore (`cast wallet import <name> --interactive`), about $10 of USDG (Robinhood Chain) or USDC (Base) and a little ETH.

```
# Robinhood Chain: dry run, then send
forge script script/TenDollar.s.sol --rpc-url $RH_RPC_URL --account <name> --sender <addr>
forge script script/TenDollar.s.sol --rpc-url $RH_RPC_URL --account <name> --sender <addr> --broadcast --slow

# Base (also works for rh)
RPC=$BASE_RPC_URL SIGNER="--account <name>" DRY=1 ./script/ten-dollar-cast.sh base
RPC=$BASE_RPC_URL SIGNER="--account <name>" ./script/ten-dollar-cast.sh base
```

Env: `AMOUNT` (6dp, default 10000000), `SLIPPAGE_BPS` (default 100), `KEEP=1` to leave the position in the vault. The run ends with the stock token in the signer's wallet; the vault and (on Base) the adapter stay deployed and empty. `ten-dollar-cast.sh base` has only been dry-run; if `keeperSwap` reverts, the cash is still in the vault and `cast send <vault> "withdrawAll(address)" <addr>` returns it.
