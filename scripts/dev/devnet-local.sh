#!/usr/bin/env bash
# Runs this checkout's API and web on this machine against Solana devnet (a test network: provenance
# `sandbox`, worthless test tokens), signed in with a real Privy wallet. The runbook is
# docs/vault/RUN-DEVNET-LOCAL.md.
#
#   scripts/dev/devnet-local.sh [both|api|web]      (default: both; Ctrl-C stops what it started)
#
# The values (the Privy app id, the model key, the faucet key) come from an env file outside this
# checkout, the main checkout's `.env` by default, handed to each process by node (`--env-file`, `process.loadEnvFile`). This
# script never prints a value, and writes no file. What decides the network is set here and wins over
# the file (a variable already in the environment is never replaced by the file):
#   - Solana live on testnet, at a public devnet node (or DEVNET_RPC_URL, used by the API only);
#   - Robinhood Chain on the mock and Base off, both on testnet, so the chains table stays as seeded;
#   - the database is the local docker one (`pnpm db:up`), never a hosted one;
#   - CORS lets in the web's origin, http://localhost:<web port>.
# It refuses to start when the shell it runs in asks for mainnet, and stops the API when the API does
# not report Solana on testnet with provenance sandbox. The API itself refuses a node with mainnet's
# genesis (apps/api/src/orders/README.md).
#
# Optional, all without values in files:
#   DEVNET_ENV_FILE        the env file (default: $HOME/Documents/Colosseum/.env)
#   DEVNET_API_PORT        default 3002
#   DEVNET_WEB_PORT        default 3010
#   DEVNET_DATABASE_URL    a local Postgres (default: the docker one on :5433)
#   DEVNET_RPC_URL         the API's devnet node (default: https://api.devnet.solana.com)
#   DEVNET_FAUCET_KEY_FILE the test faucet's Solana key, outside every checkout
#                          (default: $HOME/Documents/testnet-keys/solana-devnet-faucet.json)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${DEVNET_ENV_FILE:-$HOME/Documents/Colosseum/.env}"
API_PORT="${DEVNET_API_PORT:-3002}"
WEB_PORT="${DEVNET_WEB_PORT:-3010}"
DB_URL="${DEVNET_DATABASE_URL:-postgres://colosseum:colosseum@localhost:5433/colosseum}"
PUBLIC_DEVNET="https://api.devnet.solana.com"
API_RPC="${DEVNET_RPC_URL:-$PUBLIC_DEVNET}"
FAUCET_KEY_FILE="${DEVNET_FAUCET_KEY_FILE:-$HOME/Documents/testnet-keys/solana-devnet-faucet.json}"
WHAT="${1:-both}"

say() { echo "devnet-local: $*"; }
die() { echo "devnet-local: $*" >&2; exit 1; }

case "$WHAT" in both | api | web) ;; *) die "usage: scripts/dev/devnet-local.sh [both|api|web]" ;; esac
[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE (set DEVNET_ENV_FILE)"
case "$(cd "$(dirname "$ENV_FILE")" && pwd)" in
  "$ROOT" | "$ROOT"/*) die "the env file must be outside this checkout" ;;
esac

# 1. Nothing in the calling shell may ask for mainnet. Names are printed, never values.
for name in $(env | sed -n -E 's/^((NEXT_PUBLIC_)?CHAIN_(NETWORK|MODE)_[A-Z]+|SOLANA_RPC_URL|DEVNET_RPC_URL)=.*/\1/p'); do
  case "$(printf '%s' "${!name}" | tr '[:upper:]' '[:lower:]')" in
    *mainnet*) die "$name in this shell says mainnet; unset it" ;;
  esac
done
case "$(printf '%s' "$API_RPC" | tr '[:upper:]' '[:lower:]')" in *devnet*) ;; *)
  die "DEVNET_RPC_URL does not name devnet" ;;
esac
case "$DB_URL" in
  *@localhost:* | *@127.0.0.1:*) ;;
  *) die "DEVNET_DATABASE_URL must be a local database" ;;
esac

# 2. What decides the network, set here so the env file cannot change it.
export CHAIN_MODE_SOLANA=live CHAIN_NETWORK_SOLANA=testnet
export CHAIN_MODE_ROBINHOOD=mock CHAIN_NETWORK_ROBINHOOD=testnet
export CHAIN_MODE_BASE=off CHAIN_NETWORK_BASE=testnet
# Empty means unset to the apps, and an empty variable still wins over the file.
export CHAIN_ROUTER_SOLANA="" CHAIN_PRICE_SOURCE_SOLANA="" SOLANA_RPC_URL_FALLBACK=""
export KEEPER_ENABLED=off
export NEXT_PUBLIC_CHAIN_NETWORK_SOLANA=testnet NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD=testnet
export NEXT_PUBLIC_CHAIN_NETWORK_BASE=testnet

has() { grep -qE "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*[^[:space:]#]" "$ENV_FILE"; }
# A value of the env file, into a variable of this script, never to the screen.
from_file() { node --env-file="$ENV_FILE" -e "process.stdout.write(process.env['$1'] ?? '')"; }

# The Privy app id (an id, not a secret) under both names, whichever the file has.
if [ -z "${PRIVY_APP_ID:-}" ] && ! has PRIVY_APP_ID && has NEXT_PUBLIC_PRIVY_APP_ID; then
  PRIVY_APP_ID="$(from_file NEXT_PUBLIC_PRIVY_APP_ID)"; export PRIVY_APP_ID
fi
if [ -z "${NEXT_PUBLIC_PRIVY_APP_ID:-}" ] && ! has NEXT_PUBLIC_PRIVY_APP_ID && has PRIVY_APP_ID; then
  NEXT_PUBLIC_PRIVY_APP_ID="$(from_file PRIVY_APP_ID)"; export NEXT_PUBLIC_PRIVY_APP_ID
fi
[ -n "${PRIVY_APP_ID:-}" ] || has PRIVY_APP_ID || die "the env file has no PRIVY_APP_ID: sign-in would be off"

free_port() {
  local pid
  pid="$(lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [ -z "$pid" ] || die "port $1 is taken (pid $pid); stop it or pick another port"
}

API_PID=""
stop_api() { [ -z "$API_PID" ] || kill "$API_PID" 2>/dev/null || true; }

start_api() {
  free_port "$API_PORT"
  export API_PORT CORS_ORIGINS="http://localhost:$WEB_PORT" DATABASE_URL="$DB_URL" SOLANA_RPC_URL="$API_RPC"
  if [ -z "${TESTNET_FAUCET_SOLANA_KEY:-}" ] && [ -f "$FAUCET_KEY_FILE" ]; then
    TESTNET_FAUCET_SOLANA_KEY="$(cat "$FAUCET_KEY_FILE")"; export TESTNET_FAUCET_SOLANA_KEY
    say "test faucet: key file found"
  elif [ -n "${TESTNET_FAUCET_SOLANA_KEY:-}" ] || has TESTNET_FAUCET_SOLANA_KEY; then
    say "test faucet: key set"
  else
    say "test faucet: no key, so no test funds button (fund the wallet by hand; see the runbook)"
  fi
  say "API on http://localhost:$API_PORT (Solana devnet, origin http://localhost:$WEB_PORT)"
  (cd "$ROOT/apps/api" && exec node --env-file="$ENV_FILE" --import tsx src/server.ts) &
  API_PID=$!
  local config=""
  for _ in $(seq 1 90); do
    kill -0 "$API_PID" 2>/dev/null || die "the API stopped while starting; its log is above"
    config="$(curl -fsS "http://localhost:$API_PORT/v1/config" 2>/dev/null || true)"
    [ -z "$config" ] || break
    sleep 1
  done
  [ -n "$config" ] || { stop_api; die "the API did not answer /v1/config within 90 s"; }
  if ! printf '%s' "$config" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s);
      const sol = c.chains.find((x) => x.id === "solana");
      const ok = sol && sol.network === "testnet" && sol.mode === "live" && sol.provenance === "sandbox"
        && c.chains.every((x) => x.network !== "mainnet");
      process.exit(ok ? 0 : 1);
    });'; then
    stop_api
    die "the API does not report Solana live on testnet with provenance sandbox; stopped it"
  fi
  say "API checked: Solana live on devnet, provenance sandbox"
}

start_web() {
  free_port "$WEB_PORT"
  export NEXT_PUBLIC_API_URL="http://localhost:$API_PORT"
  # The browser's node is always the public one: a NEXT_PUBLIC_ value is shipped to the page.
  export NEXT_PUBLIC_CHAIN_READ_RPC_SOLANA="$PUBLIC_DEVNET" NEXT_PUBLIC_SOLANA_RPC_URL="$PUBLIC_DEVNET"
  export NEXT_PUBLIC_WALLET_DRIVER=""
  say "web on http://localhost:$WEB_PORT (API http://localhost:$API_PORT)"
  cd "$ROOT/apps/web"
  # Next hands its own node flags to its workers through NODE_OPTIONS, where --env-file is refused, so
  # the file is loaded here instead (process.loadEnvFile also leaves a variable already set alone).
  node -e '
    const [file, port] = process.argv.slice(1);
    process.loadEnvFile(file);
    const next = require("node:child_process").spawn(
      process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", port], { stdio: "inherit" });
    for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => next.kill(s));
    next.on("exit", (code) => process.exit(code ?? 1));
  ' "$ENV_FILE" "$WEB_PORT"
}

case "$WHAT" in
  api)
    trap stop_api INT TERM
    start_api
    wait "$API_PID"
    ;;
  web) start_web ;;
  both)
    trap stop_api EXIT INT TERM
    start_api
    start_web
    ;;
esac
