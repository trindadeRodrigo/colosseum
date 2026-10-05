# @colosseum/sdk

The guard, which reads a transaction's bytes and refuses anything that is not the step the person approved, and the order executor the web and outside agents share. The design is `docs/vault/DESIGN-VAULT.md`, section 9 (the guard) and section 11 (the executor); what the web must hand the executor is in `apps/web/features/wallet/README.md`, "Before any product screen signs".

## Deployment files

The guard derives every address from a deployment, and takes one only as this package loaded it from the file committed for its network: `deployments/<network>.json`, with `"format": "guard-deployment/1"`. `local.example.json` shows a Solana and an EVM entry; `mock.json` is the mock's. A file is written in the pull request of the deploy to that network, and `pnpm --filter @colosseum/sdk tables` puts it into the package, frozen (`src/guard/generated/deployment-files.ts`); `scripts/tables.test.ts` fails while the two disagree. `deploymentsOf(network)` reads only those; `readDeploymentFile(content)` checks a file before it is committed and makes nothing the guard takes. The package's tests load deployments of their own through `test/deployments.ts`, swapped in with `vi.mock`. The test network's file and the transaction builders depend on this shape: a change to it is said in the pull request that makes it.

## For whoever builds the transactions

What the guard passes, so a builder knows before it builds (ADS-2 on Solana, ADE-2 on EVM):

- **Lookup tables (Solana).** Every account an instruction names in the interface (owner, vault, config, asset list, mints, token programs, the vault's and the person's token accounts, the router) must be one of the message's own keys. A named account loaded from a lookup table is refused, as is a program id. Only the trailing accounts may come from a table: a swap's route (`owner_swap`) and a withdrawal's transfer-hook accounts (`withdraw`). A platform table that holds Config, the asset list, the cash mint or the listed mints gives transactions the guard refuses.
- **Solana, besides the program's own instructions:** at most one compute unit limit and one unit price, nothing else of the compute-budget program, under the fee ceiling (0.005 SOL unless the deployment says otherwise; with no limit stated the price is counted on 1.4 million units). "Create this token account if it is missing" only for a token the step moves, paid by the person, for the vault's account of what comes in or the person's of what goes out, once each. No System or token-program instruction at the top level. One signer, the person, who pays the fee.
- **EVM:** a call, not a transaction: `to`, `value` `"0"`, `chainId`, the call data, and a nonce and gas limit if stated. Any other field is refused.
- **Minimums are held to equality** with what the review screen showed, so a rebuild at a new quote is refused until the person reviews again.

## Reading the chain

The executor signs an approved step once. A second signature needs the chain's word that the first can no longer land, through `chainReadOf({ solana, evm })`: one `RpcCall` per family, each to one node (`rpcAt(url)`), never the API and never a load-balanced URL, since a node that is behind and one that is ahead can each answer one of the reads. On Solana the node must have a transaction's blockhash before it is signed, and its block height then is kept with the signature; the first is gone once the finalized height is past that plus 150 blocks and a margin of 30, with no transaction of that signature on the chain. That last read searches the history, so the node must keep transaction history: one that keeps only recent slots would say not found for a transaction that landed. Whether a blockhash is valid at `finalized` proves nothing: the finalized block trails the tip. On EVM it is gone once the finalized nonce has moved past it and the chain does not have it.

## Tests

`test/bites.ts` runs each negative twice: the whole guard refuses it with the code of one check, and with that check taken out it passes. The switch that takes a check out, or reads against another interface, is `test/rules.ts`, which a test file puts in place of `src/guard/rules.ts` with `vi.mock`. It is not in the guard, and nothing the package builds imports from `test/` (`src/guard/rules.test.ts`).
