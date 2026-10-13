#!/usr/bin/env bash
# The keeper on its machine: one chain a process, a round every KEEPER_INTERVAL seconds (60 by default),
# started again 30 s after it stops, whatever stopped it. Its state file's lock stops a second keeper on
# the same chain from running beside it, so starting this twice does nothing harmful.
#
#   scripts/keeper/run.sh robinhood            # or solana; extra flags go to the keeper (--dry-run)
#
# Everything else comes from the environment, which the machine sets and nothing here prints: for
# Robinhood Chain ROBINHOOD_RPC_URL and KEEPER_ROBINHOOD_KEY, for Solana SOLANA_RPC_URL and
# KEEPER_SOLANA_KEYPAIR; on either KEEPER_DISCORD_WEBHOOK, KEEPER_HEALTHCHECK_URL, KEEPER_LOW_GAS and
# KEEPER_STATE_DIR. See apps/keeper/README.md.
set -u
chain="${1:-}"
case "$chain" in
  solana | robinhood) shift ;;
  *) echo "say solana or robinhood" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/../.." || exit 1
while true; do
  KEEPER_CHAIN="$chain" pnpm --filter @colosseum/keeper start --loop --interval "${KEEPER_INTERVAL:-60}" "$@"
  echo "keeper ($chain) stopped with $?; starting again in 30 s" >&2
  sleep 30
done
