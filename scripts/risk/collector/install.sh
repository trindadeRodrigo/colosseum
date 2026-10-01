#!/bin/zsh
# Installs the risk-layer collectors as their own launchd agents, separate from the old depth job:
#   com.colosseum.risk-pools   pool snapshots (Step 2), minutes 2,7,...,57
#   com.colosseum.risk-quotes  Jupiter cross-check (Step 3), minutes 4,19,34,49
#   com.colosseum.risk-refresh import into Postgres + recompute curves, minute 10 of every hour
#   com.colosseum.risk-lending lending pools (Step 10b), minutes 1,6,...,56 (one-job mode only: `install.sh lending`)
# With no argument, installs pools, quotes and refresh as before. With a job name (`install.sh lending`), builds
# and loads only that job: the running jobs are not reloaded and the shared env file is not rewritten.
# Own directory (~/.colosseum/risk) and env file. Each collector is bundled with its decoders into one
# dependency-free file because launchd agents cannot read ~/Documents. Re-run after code changes.
set -euo pipefail
ONLY="${1:-}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
HOME_DIR="$HOME/.colosseum/risk"
NODE_BIN="$(dirname "$(which node)")"
mkdir -p "$HOME_DIR" "$HOME/Library/LaunchAgents"
if [ -z "$ONLY" ]; then
  [ -f "$HOME_DIR/registry.json" ] || { echo "run pnpm risk:registry first"; exit 1; }
  grep -E '^(SOLANA_RPC_URL|JUPITER_API_KEY)=' "$REPO/.env" > "$HOME_DIR/env" || true
  chmod 600 "$HOME_DIR/env"
fi
grep -q '^SOLANA_RPC_URL=' "$HOME_DIR/env" || { echo "SOLANA_RPC_URL missing in $HOME_DIR/env (run install.sh with no argument once)"; exit 1; }
install_job() {
  local name=$1 label=$2; shift 2
  "$REPO/node_modules/.bin/esbuild" "$REPO/scripts/risk/collector/$name.ts" --bundle --platform=node \
    --format=esm --target=node22 --tsconfig="$REPO/tsconfig.json" --outfile="$HOME_DIR/risk-$name.mjs" --log-level=warning \
    --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
  local minutes=""
  for m in "$@"; do minutes+="    <dict><key>Minute</key><integer>$m</integer></dict>\n"; done
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  sed -e "s#__LABEL__#$label#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__HOME_DIR__#$HOME_DIR#g" \
    -e "s#__SCRIPT__#risk-$name#g" -e "s#__MINUTES__#$minutes#" \
    "$REPO/scripts/risk/collector/risk-job.plist" > "$plist"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "loaded $label -> $HOME_DIR/risk-$name.mjs"
}
if [ -n "$ONLY" ]; then
  case "$ONLY" in
    lending)
      [ -f "$HOME_DIR/lending-registry.json" ] || { echo "run pnpm risk:lending-registry first"; exit 1; }
      install_job lending com.colosseum.risk-lending 1 6 11 16 21 26 31 36 41 46 51 56 ;;
    *) echo "unknown job: $ONLY (one-job mode supports: lending)"; exit 1 ;;
  esac
  exit 0
fi
install_job pools com.colosseum.risk-pools 2 7 12 17 22 27 32 37 42 47 52 57
install_job quotes com.colosseum.risk-quotes 4 19 34 49
cp "$REPO/fixtures/risk/us-market-holidays.json" "$HOME_DIR/us-market-holidays.json"
grep -q "^RISK_HOLIDAYS=" "$HOME_DIR/env" || echo "RISK_HOLIDAYS=$HOME_DIR/us-market-holidays.json" >> "$HOME_DIR/env"
install_job refresh com.colosseum.risk-refresh 10
