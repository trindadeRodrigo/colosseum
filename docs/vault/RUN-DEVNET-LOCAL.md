# Run the product on this machine, on Solana devnet

What this gives: the web and the API of one checkout, on your machine, signed in with your own Privy passkey wallet, buying a plan on Solana devnet. Devnet is a test network: every figure is `"provenance": "sandbox"`, the tokens are worthless test tokens (`tUSDC`, `tSPYx`, …), and nothing touches mainnet. Ledger row `DEV-DEVNET-LOCAL`.

The launcher is `scripts/dev/devnet-local.sh` (`pnpm dev:devnet`). It reads the values (the Privy app id, the model key, a faucet key) from the main checkout's `.env`, never prints one and writes no file. What decides the network it sets itself, and those win over the file:

| Set by the launcher | Value |
|---|---|
| Solana | `CHAIN_MODE_SOLANA=live`, `CHAIN_NETWORK_SOLANA=testnet`, the API's node `https://api.devnet.solana.com` (or `DEVNET_RPC_URL`) |
| Robinhood Chain, Base | the mock and off, both on `testnet`, as the local database's `chains` rows are seeded |
| Database | the local docker one (`postgres://…@localhost:5433/colosseum`, `pnpm db:up`); a hosted one is refused |
| CORS | `http://localhost:3010`, the web's origin |
| Web | `NEXT_PUBLIC_API_URL=http://localhost:3002`, `NEXT_PUBLIC_CHAIN_NETWORK_SOLANA=testnet`, the browser's node `https://api.devnet.solana.com`, the Privy wallet (never the test driver) |
| Keeper | off |

It refuses to start when the shell asks for mainnet (`CHAIN_NETWORK_*`, `NEXT_PUBLIC_CHAIN_NETWORK_*`, `SOLANA_RPC_URL`), and stops the API when `/v1/config` does not say Solana live on testnet with provenance `sandbox`. The API also refuses a node with mainnet's genesis, and a `basket_assets` row the devnet record (`deployments/solana-devnet.json`) does not make.

## Once

1. **The database is up and on devnet.** `pnpm db:up` from any checkout. The local database already holds the devnet `chains` rows and the 14 devnet `basket_assets` rows (checked Oct 8). If it ever does not: `pnpm exec tsx scripts/solana/basket-assets.ts` with `DATABASE_URL` set to the local database; it writes rows and sends nothing.
2. **The Privy app lets `http://localhost:3010` in.** Privy dashboard, the app whose id is `PRIVY_APP_ID` in the main checkout's `.env`: add `http://localhost:3010` to the allowed origins (and keep `http://localhost:3000` if Thom's local copy uses it). Login methods passkey on, identity tokens on. Without the origin, Privy answers `invalid_origin` and the screen says "Sign-in isn't set up for this address" (WEB-BAR-NEVER-EMPTY).
3. **The env file has the app id.** The main checkout's `.env` needs `PRIVY_APP_ID` (or `NEXT_PUBLIC_PRIVY_APP_ID`; the launcher uses one for the other) and the model key the goal conversation uses. The launcher stops and names `PRIVY_APP_ID` if it is missing; it never shows the value.
4. **Test funds, one of two ways.**
   - **The faucet (one press on the buy screen).** The devnet faucet wallet `8E7hk2pfnUoKSSc8EeCohTFBxnx47Q7nKwZHqpdaBkvS` is funded (1 SOL and 20,000 tUSDC on Oct 8, gate `TEST-FAUCET`), but its key is not on this machine: Thom made it with `scripts/testnet/make-faucet-keys.ts`. Get the file `solana-devnet-faucet.json` from him by a private channel (never chat, never the repo) and keep it at `~/Documents/testnet-keys/solana-devnet-faucet.json`:

     ```
     ! mkdir -p ~/Documents/testnet-keys && chmod 700 ~/Documents/testnet-keys
     ! mv ~/Downloads/solana-devnet-faucet.json ~/Documents/testnet-keys/ && chmod 600 ~/Documents/testnet-keys/solana-devnet-faucet.json
     ```

     The launcher hands it to the API as `TESTNET_FAUCET_SOLANA_KEY` and says "test faucet: key file found". The buy screen then offers "Get test funds": what the buy is missing, at most $5,000 and 0.05 SOL a send, three sends a day.
   - **By hand, without the faucet key.** Sign in once (below) to learn your Solana address. Gas: 0.05 devnet SOL from https://faucet.solana.com to that address. Test dollars: ask Thom to send tUSDC (mint `AEtFZt8Fq4PYzBs4d8VoMypDDhjp9XTv6qvhJZhd8BUn`) from the faucet wallet or the deploy key, which alone can mint them (`apps/web/features/wallet/README.md`, "A buy on devnet").

## Each time

```
! cd ~/Documents/Colosseum-web-identity && pnpm dev:devnet
```

That starts the API on `:3002` and the web on `:3010`; Ctrl-C stops both. `pnpm dev:devnet api` or `pnpm dev:devnet web` starts one. A port in use stops it with the pid that holds it. Only one `next dev` may run per checkout: stop any other web server of this checkout first. Use `localhost`, not `127.0.0.1`.

## The buy, in the browser

Chrome or Safari, at `http://localhost:3010`.

1. **Sign in** with "Use my passkey" (or "Create a passkey" the first time). Use the passkey, not Phantom: Phantom adds instructions of its own to a devnet transaction and the guard refuses them. Choose **Solana** as the chain your plan lives on. The bar shows your Solana address.
2. **Invest** (`/goal`): say the goal (about $20 is plenty), answer what is asked, confirm the sheet, "Build my plan".
3. **See your plan** (`/plan/<id>`): the holdings with their pins, the card's line "Sample figures · test network", the disclaimer. "Deposit $20".
4. **Fund** (`/plan/<id>/buy`): "What your wallet needs" with tUSDC and SOL. Short: press "Get test funds" (with the faucet key), or fund by hand and "Read my wallet again".
5. Tick "I've read this and I accept it", then "Deposit $20".
6. **Order** (`/orders/<id>`): "Sign and deposit $20". No passkey prompt and no Privy window; each step turns "Confirmed" with "Tx ↗" (Solscan on devnet).
7. **Portfolio** (`/monitor`): the vault and what it holds, on Solana devnet.

The step-by-step table with what each screen should say is in `apps/web/features/wallet/README.md`, "A buy on devnet".

## How to tell it is devnet

- The buy card's line reads "Test network · Solana · not live" (gate `BUY-STEPS`); cards with figures carry "Sample figures · test network" and the hatch (gate `MOCK-QUIET`).
- Every Solscan link ends in `?cluster=devnet`.
- `curl -s localhost:3002/v1/config` shows Solana `"network":"testnet"`, `"networkName":"devnet"`, `"provenance":"sandbox"`.

## Stop

Ctrl-C in the launcher's terminal. For a launcher started in the background: `lsof -nP -tiTCP:3002 -sTCP:LISTEN` and `lsof -nP -tiTCP:3010 -sTCP:LISTEN` give the pids to `kill`.

## If something fails

| What you see | Why, and what to do |
|---|---|
| "port 3010 is taken (pid …)" | Another web server holds it; stop it or `DEVNET_WEB_PORT=3011 pnpm dev:devnet` (then add that origin to Privy too) |
| "Sign-in isn't set up for this address" | Step 2 of "Once": the origin is not in the Privy app |
| "I can't tell yet which chain your plan lives on" after a good sign-in | The API refused `/v1/me`: identity tokens off in the dashboard (401) or the API is not the launcher's (check `NEXT_PUBLIC_API_URL` is `:3002`) |
| No "Get test funds" | No faucet key: step 4 of "Once" |
| "Our test funds are low" | The faucet float is spent: ask Thom to top up `8E7hk2pf…` |
| The API stops at start naming a `basket_assets` row | The local database disagrees with `deployments/solana-devnet.json`: run `scripts/solana/basket-assets.ts` (step 1) |
