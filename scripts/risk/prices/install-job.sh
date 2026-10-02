#!/bin/zsh
# Installs the hourly price job (PLAN-RISK Step 11 item 5, D22) as its own launchd agent:
#   com.colosseum.risk-prices   new collector rows into risk_price_observations, reference prices for the last two
#                               days into risk_reference_prices, minute 14 of every hour (after risk-refresh at 10
#                               and risk-lending-import at 12)
# It sits beside the collectors and touches none of them: it builds one bundle, writes one plist, and loads that
# one agent. It reads scripts/risk/collector/risk-job.plist as its template and the shared env file
# (~/.colosseum/risk/env) without changing either. launchd agents cannot read ~/Documents, so the job is bundled
# with its dependencies into ~/.colosseum/risk/risk-prices.mjs. Re-run after code changes.
# The tables must exist first: pnpm db:migrate. Remove with:
#   launchctl unload ~/Library/LaunchAgents/com.colosseum.risk-prices.plist
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
HOME_DIR="$HOME/.colosseum/risk"
NODE_BIN="$(dirname "$(which node)")"
LABEL="com.colosseum.risk-prices"
NAME="prices"
MINUTE=14
[ -f "$HOME_DIR/env" ] || { echo "$HOME_DIR/env missing: the collectors are not installed on this machine"; exit 1; }
[ -f "$HOME_DIR/lending-registry.json" ] || { echo "run pnpm risk:lending-registry first"; exit 1; }
"$REPO/node_modules/.bin/esbuild" "$REPO/scripts/risk/prices/job.ts" --bundle --platform=node \
  --format=esm --target=node22 --tsconfig="$REPO/tsconfig.json" --outfile="$HOME_DIR/risk-$NAME.mjs" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MINUTES="    <dict><key>Minute</key><integer>$MINUTE</integer></dict>\n"
sed -e "s#__LABEL__#$LABEL#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__HOME_DIR__#$HOME_DIR#g" \
  -e "s#__SCRIPT__#risk-$NAME#g" -e "s#__MINUTES__#$MINUTES#" \
  "$REPO/scripts/risk/collector/risk-job.plist" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded $LABEL -> $HOME_DIR/risk-$NAME.mjs (minute $MINUTE)"
