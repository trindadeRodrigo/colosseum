#!/bin/zsh
# Installs the hourly raw-arrays job (PLAN-UNIVERSE RU.12) as its own launchd agent:
#   com.colosseum.risk-raw-arrays   the pool account and every tick or bin array of each concentrated-liquidity pool
#                                   of the tracked stocks that the pool collector does not record itself, minute 25 of
#                                   every hour, into ~/.colosseum/risk/raw-arrays (a folder of its own)
# Usage: install-job.sh                                    the install: a person's
#        COLOSSEUM_HOME=<folder> install-job.sh --no-load  a rehearsal: bundle and plist under <folder>, nothing loaded
# It sits beside the collectors and touches none of them, the way the price job was added (gate PRICE-JOB): it builds
# one bundle, writes one plist, and loads that one agent. It reads scripts/risk/collector/risk-job.plist as its
# template and leaves it as it is; it neither writes nor prints the shared env file (~/.colosseum/risk/env), and
# checks only that the file names an RPC. launchd agents cannot read ~/Documents, so the job is bundled with its
# dependencies and with the list of tracked stocks (scripts/risk/universe/solana.json) into
# ~/.colosseum/risk/risk-raw-arrays.mjs. Run it again after a code change and after a new list. The job reads the
# collector's registry.json and cache.json and never writes them.
#
# The folder the job writes into is put inside the bundle (<home>/raw-arrays): the source has no default, so only an
# installed bundle knows where to write. Two settings are taken from this command's own environment and put in the
# bundle the same way, because the collector's installer rewrites the shared env file:
#   RISK_RAW_ARRAYS_ALL=1                 also record the pools the collector writes itself
#   RISK_RAW_ARRAYS_SKIP=other,via_xstock leave out pools by exit path
# A line in the env file still wins over the bundle.
#
# Minute 25: after every hourly job (refresh 10, lending import 12, prices 14, split 15, lending facts 20) and three
# minutes after the pool collector's run of minute 22 begins. Of its 137 runs of that minute from Oct 1 to Oct 7 none
# was still going at :25:00 (median 22 s, 95 in 100 within 87 s, the longest 148 s); it rewrites cache.json as it ends.
# The lending collector starts a minute later and the next quotes run nine minutes later.
#
# A rehearsal is any run whose COLOSSEUM_HOME is not ~/.colosseum/risk: nothing is loaded, and the plist goes under
# $COLOSSEUM_HOME/LaunchAgents. A plist left in ~/Library/LaunchAgents is loaded at the next login whether or not this
# script loaded it, so --no-load is refused without a rehearsal folder. Remove the job with:
#   launchctl unload ~/Library/LaunchAgents/com.colosseum.risk-raw-arrays.plist
#   rm ~/Library/LaunchAgents/com.colosseum.risk-raw-arrays.plist
set -euo pipefail

usage() { echo "usage: install-job.sh | COLOSSEUM_HOME=<folder> install-job.sh --no-load"; exit 1; }
LOAD=1
for a in "$@"; do
  case "$a" in
    --no-load) LOAD=0 ;;
    *) usage ;;
  esac
done

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEFAULT_HOME="$HOME/.colosseum/risk"
# set and empty is a mistake in the command (a variable that was never filled), not a request for the default
if [ -n "${COLOSSEUM_HOME+x}" ] && [ -z "$COLOSSEUM_HOME" ]; then
  echo "COLOSSEUM_HOME is set and empty: name the rehearsal folder, or unset it for the install"
  exit 1
fi
HOME_DIR="${COLOSSEUM_HOME:-$DEFAULT_HOME}"
# absolute, so the bundle built there can be started from another folder
HOME_DIR="${HOME_DIR:a}"
NODE_BIN="$(dirname "$(which node)")"
LABEL="com.colosseum.risk-raw-arrays"
NAME="raw-arrays"
MINUTE=25

# Two names of one folder are one folder. What the disk says a path is (its device and inode, links followed) decides
# it where the path exists: a link, another letter case and another spelling of the volume
# (/System/Volumes/Data/Users/...) all give the same answer. Where it does not exist yet, the name decides, with
# links resolved and case folded.
id_of() { stat -f '%d:%i' "$1" 2>/dev/null || stat -c '%d:%i' "$1" 2>/dev/null || true; }
canon() { local p="${1:A}"; echo "${p:l}"; }
same_folder() {
  local a="$(id_of "$1")" b="$(id_of "$2")"
  if [ -n "$a" ] && [ "$a" = "$b" ]; then return 0; fi
  [ "$(canon "$1")" = "$(canon "$2")" ]
}
# $1 is $2 or inside it: $1 and each folder above it is tried
inside() {
  local p="$1"
  while :; do
    if same_folder "$p" "$2"; then return 0; fi
    if [ "$p" = "${p:h}" ]; then return 1; fi
    p="${p:h}"
  done
}
if same_folder "$HOME_DIR" "$DEFAULT_HOME"; then
  REHEARSAL=0
  HOME_DIR="$DEFAULT_HOME"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  if [ "$LOAD" = 0 ]; then
    echo "refusing --no-load at $DEFAULT_HOME: the plist would be loaded at the next login all the same."
    echo "For a rehearsal, name a folder: COLOSSEUM_HOME=<folder> install-job.sh --no-load"
    exit 1
  fi
else
  REHEARSAL=1
  PLIST_DIR="$HOME_DIR/LaunchAgents"
  # the plist carries the live job's label, so loading it would replace the running job: a rehearsal never loads
  LOAD=0
  for live in "$HOME/.colosseum" "$HOME/Library"; do
    if inside "$HOME_DIR" "$live"; then
      echo "refusing: a rehearsal folder inside $live ($HOME_DIR)"
      exit 1
    fi
  done
  echo "rehearsal: COLOSSEUM_HOME=$HOME_DIR is not the default; nothing is loaded"
fi
# The plist's command is one line of text, and sed writes these two paths into it: a space or a quote would cut the
# command in two, and #, & or \ would be read by sed.
case "$HOME_DIR$NODE_BIN" in
  *[[:space:]\#\&\\\'\"]*)
    echo "refusing: $HOME_DIR or $NODE_BIN holds a space, a quote, #, & or a backslash, which the plist cannot carry"
    exit 1 ;;
esac

# The job needs the collectors' env file (for the RPC), registry and cache. A real install stops without them; a
# rehearsal says so and goes on, since it only builds.
need() {
  if [ "$REHEARSAL" = 1 ]; then echo "rehearsal: $1"; else echo "$1"; exit 1; fi
}
[ -f "$HOME_DIR/env" ] || need "$HOME_DIR/env missing: the collectors are not installed on this machine"
if [ -f "$HOME_DIR/env" ] && ! grep -q '^SOLANA_RPC_URL=' "$HOME_DIR/env"; then
  need "SOLANA_RPC_URL missing in $HOME_DIR/env (run scripts/risk/collector/install.sh with no argument once)"
fi
[ -f "$HOME_DIR/registry.json" ] || need "$HOME_DIR/registry.json missing: run pnpm risk:registry first"
[ -f "$HOME_DIR/cache.json" ] || need "$HOME_DIR/cache.json missing: the pool collector has not run yet"

ESBUILD="$REPO/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  # esbuild is not a direct dependency; take the newest copy pnpm installed for vite/tsx.
  ESBUILD="$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)"
fi
[ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found under $REPO/node_modules (run pnpm install)"; exit 1; }

# What the bundle is told before any of its code runs: its folder, and the settings given to this command. Each is
# set only when the environment of a run does not already say (a line in the env file wins).
js() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
SETTINGS="process.env.RISK_RAW_ARRAYS_DIR ??= $(js "$HOME_DIR/raw-arrays");"
echo "the job's folder: $HOME_DIR/raw-arrays"
for key in RISK_RAW_ARRAYS_ALL RISK_RAW_ARRAYS_SKIP; do
  value="${(P)key:-}"
  if [ -n "$value" ]; then
    SETTINGS+=" process.env.$key ??= $(js "$value");"
    echo "setting put in the bundle: $key=$value"
  fi
done

mkdir -p "$HOME_DIR/raw-arrays" "$PLIST_DIR"
OUT="$HOME_DIR/risk-$NAME.mjs"
# Built beside the bundle the job may be running, proven to start, and only then put in its place.
NEW="$HOME_DIR/risk-$NAME.new.mjs"
trap 'rm -f "$NEW"' EXIT
"$ESBUILD" "$REPO/scripts/risk/raw-arrays/job.ts" --bundle --platform=node \
  --format=esm --target=node22 --tsconfig="$REPO/tsconfig.json" --outfile="$NEW" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url); $SETTINGS"
"$NODE_BIN/node" --check "$NEW"
# a bundle can parse and still not start: --plan loads every module and reads the registry and the cache, with no
# network and nothing written
if [ -f "$DEFAULT_HOME/registry.json" ] && [ -f "$DEFAULT_HOME/cache.json" ]; then
  (cd / && "$NODE_BIN/node" "$NEW" --plan > /dev/null) || { echo "the new bundle does not start; the old one is left in place"; exit 1; }
  echo "the new bundle starts (--plan)"
else
  echo "not proven to start: $DEFAULT_HOME/registry.json or cache.json is missing"
fi
# The plist is written beside its place, checked, and moved in only once it is whole: a re-install never leaves the
# installed one empty.
PLIST="$PLIST_DIR/$LABEL.plist"
NEW_PLIST="$PLIST.new"
trap 'rm -f "$NEW" "$NEW_PLIST"' EXIT
MINUTES="    <dict><key>Minute</key><integer>$MINUTE</integer></dict>\n"
sed -e "s#__LABEL__#$LABEL#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__HOME_DIR__#$HOME_DIR#g" \
  -e "s#__SCRIPT__#risk-$NAME#g" -e "s#__MINUTES__#$MINUTES#" \
  "$REPO/scripts/risk/collector/risk-job.plist" > "$NEW_PLIST"
if grep -q '__[A-Z_]*__' "$NEW_PLIST"; then echo "the plist template has a slot this installer does not fill"; exit 1; fi
if command -v plutil > /dev/null; then plutil -lint "$NEW_PLIST" > /dev/null || { echo "the new plist is not a plist"; exit 1; }; fi

if [ -f "$OUT" ]; then
  BEFORE="$HOME_DIR/risk-$NAME.before-$(date +%Y%m%d-%H%M%S).mjs"
  cp -p "$OUT" "$BEFORE"
  echo "kept the bundle that was there: $BEFORE"
fi
mv -f "$NEW" "$OUT"
echo "bundled $OUT ($(du -h "$OUT" | cut -f1))"
mv -f "$NEW_PLIST" "$PLIST"
echo "wrote $PLIST"
if [ "$LOAD" = 1 ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "loaded $LABEL -> $OUT (minute $MINUTE)"
else
  echo "not loaded: $LABEL (minute $MINUTE)"
fi
echo "recordings: $HOME_DIR/raw-arrays/<day>/<hour>/<pool>.json.gz, one line per run in $HOME_DIR/raw-arrays/runs.jsonl"
echo "log: $HOME_DIR/risk-$NAME.log"
