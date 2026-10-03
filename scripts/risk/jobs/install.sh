#!/bin/zsh
# Installs the two hourly facts jobs (PLAN-ANALYTICS item 18) as their own launchd agents, the way
# scripts/risk/collector/install.sh installs the collectors (that folder is not edited before Oct 12):
#   com.colosseum.risk-facts-split    split snapshot + cost breakdown, minute 15 (after the refresh's compute at 10)
#   com.colosseum.risk-facts-lending  lending report + facts import, minute 20 (after the lending import at 12),
#                                     node with --max-old-space-size=8192
# Usage: install.sh <facts-split|facts-lending|all> [--no-load]
# Each wrapper (scripts/risk/jobs/*.ts) is bundled with its dependencies into one file because launchd agents cannot
# read ~/Documents. The files the jobs read and write live in $COLOSSEUM_HOME/data (DA8), named by RISK_DATA_DIR in
# the env file; the repo's data/risk/split and data/risk/lending-history/report become symlinks to it, so hand-run
# commands and the jobs share one copy. Re-run after code changes, and after `pnpm risk:lending-follow` or a decode
# pass (it re-copies the report's history inputs).
#
# COLOSSEUM_HOME (default ~/.colosseum/risk) names the folder. When it is not the default, the run is a rehearsal:
# the plists go to $COLOSSEUM_HOME/LaunchAgents, the repo's files are copied (not moved) into the data folder, and
# the two repo folders are left as they are (the symlink step is printed, not done). --no-load writes everything but
# does not call launchctl. The env file is never rewritten: missing lines are appended, nothing is printed from it.
set -euo pipefail
setopt null_glob

usage() { echo "usage: install.sh <facts-split|facts-lending|all> [--no-load]"; exit 1; }
JOB=""
LOAD=1
for a in "$@"; do
  case "$a" in
    --no-load) LOAD=0 ;;
    facts-split|facts-lending|all) JOB="$a" ;;
    *) usage ;;
  esac
done
[ -n "$JOB" ] || usage

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEFAULT_HOME="$HOME/.colosseum/risk"
HOME_DIR="${COLOSSEUM_HOME:-$DEFAULT_HOME}"
HOME_DIR="${HOME_DIR%/}"
DATA="$HOME_DIR/data"
ENV_FILE="$HOME_DIR/env"
NODE_BIN="$(dirname "$(which node)")"
if [ "$HOME_DIR" = "$DEFAULT_HOME" ]; then
  REHEARSAL=0
  PLIST_DIR="$HOME/Library/LaunchAgents"
else
  REHEARSAL=1
  PLIST_DIR="$HOME_DIR/LaunchAgents"
  # the plists carry the live jobs' labels, so loading one would replace the running job: a rehearsal never loads
  LOAD=0
  echo "rehearsal: COLOSSEUM_HOME=$HOME_DIR is not the default; repo folders are copied, not moved or linked; nothing is loaded"
fi
WANT_SPLIT=0
WANT_LENDING=0
case "$JOB" in
  facts-split) WANT_SPLIT=1 ;;
  facts-lending) WANT_LENDING=1 ;;
  all) WANT_SPLIT=1; WANT_LENDING=1 ;;
esac

ESBUILD="$REPO/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  # esbuild is not a direct dependency; take the newest copy pnpm installed for vite/tsx.
  ESBUILD="$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)"
fi
[ -n "$ESBUILD" ] && [ -x "$ESBUILD" ] || { echo "esbuild not found under $REPO/node_modules (run pnpm install)"; exit 1; }

# ------------------------------------------------------------------ the repo folders that become symlinks (DA8)
# Checked for every folder before anything is changed: a folder that is already a symlink to somewhere else stops
# the run.
REPO_SPLIT="$REPO/data/risk/split"
REPO_REPORT="$REPO/data/risk/lending-history/report"
check_link() {
  local repo_dir=$1 data_dir=$2
  if [ -L "$repo_dir" ]; then
    local target
    target="$(readlink "$repo_dir")"
    if [ "${target%/}" != "$data_dir" ]; then
      echo "refusing: $repo_dir is already a symlink to $target, not $data_dir"
      exit 1
    fi
  fi
}
if [ "$WANT_SPLIT" = 1 ]; then check_link "$REPO_SPLIT" "$DATA/split"; fi
if [ "$WANT_LENDING" = 1 ]; then check_link "$REPO_REPORT" "$DATA/lending-history/report"; fi

mkdir -p "$HOME_DIR" "$PLIST_DIR" "$DATA/split" "$DATA/lending-history/report"

# Moves the repo's files into the data folder and replaces the repo folder with a symlink to it. In a rehearsal it
# copies the files and prints what the real run would do.
link_repo_folder() {
  local repo_dir=$1 data_dir=$2 ext=$3
  if [ -L "$repo_dir" ]; then
    echo "already linked: $repo_dir -> $data_dir"
    return
  fi
  local files=()
  if [ -d "$repo_dir" ]; then files=("$repo_dir"/*.$ext); fi
  if [ "$REHEARSAL" = 1 ]; then
    for f in "${files[@]}"; do
      cp -p "$f" "$data_dir/"
      echo "copied (rehearsal) $f -> $data_dir/"
    done
    echo "rehearsal: the real run moves ${#files[@]} file(s) from $repo_dir into $data_dir and replaces $repo_dir with a symlink to $data_dir"
    return
  fi
  for f in "${files[@]}"; do
    local dest="$data_dir/${f:t}"
    if [ -e "$dest" ] && ! cmp -s "$f" "$dest"; then
      echo "refusing: $dest exists and differs from $f"
      exit 1
    fi
    mv -f "$f" "$dest"
    echo "moved $f -> $dest"
  done
  if [ -d "$repo_dir" ]; then
    local left=("$repo_dir"/*(DN))
    if [ ${#left[@]} -gt 0 ]; then
      echo "refusing to replace $repo_dir: it still holds ${#left[@]} other file(s); move them and re-run"
      exit 1
    fi
    rmdir "$repo_dir"
  fi
  mkdir -p "$(dirname "$repo_dir")"
  ln -s "$data_dir" "$repo_dir"
  echo "linked $repo_dir -> $data_dir"
}

copy_input() {
  local src=$1 dest=$2
  if [ ! -e "$src" ]; then
    echo "missing (the report gives null with a reason for it): $src"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  if [ -d "$src" ]; then
    mkdir -p "$dest"
    cp -Rp "$src/." "$dest/"
  else
    cp -p "$src" "$dest"
  fi
  echo "copied $(du -sh "$dest" | cut -f1) $src -> $dest"
}

# ------------------------------------------------------------------ env file (never rewritten, never printed)
[ -e "$ENV_FILE" ] || touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
append_env() {
  local key=$1 value=$2
  if grep -q "^$key=" "$ENV_FILE"; then
    echo "env: $key already set, left as it is"
  else
    echo "$key=$value" >> "$ENV_FILE"
    echo "env: appended $key=$value"
  fi
}
if ! grep -q '^RISK_HOLIDAYS=' "$ENV_FILE"; then
  cp "$REPO/fixtures/risk/us-market-holidays.json" "$HOME_DIR/us-market-holidays.json"
  append_env RISK_HOLIDAYS "$HOME_DIR/us-market-holidays.json"
fi
append_env RISK_DATA_DIR "$DATA"
if ! grep -q '^SOLANA_RPC_URL=' "$ENV_FILE"; then
  if [ "$LOAD" = 1 ]; then
    echo "SOLANA_RPC_URL missing in $ENV_FILE (run scripts/risk/collector/install.sh with no argument once)"
    exit 1
  fi
  echo "warning: SOLANA_RPC_URL missing in $ENV_FILE; the jobs need it before they are loaded"
fi

# ------------------------------------------------------------------ bundle, plist, load
# Copies the whirlpools-core .wasm of the exact version the bundle contains (esbuild's path comments name it).
copy_wasm() {
  local bundle=$1 wasm=orca_whirlpools_core_js_bindings_bg.wasm
  local pkg
  pkg="$(grep -o 'node_modules/\.pnpm/@orca-so+whirlpools-core@[^/]*/node_modules/@orca-so/whirlpools-core' "$bundle" | sort -u)"
  if [ -z "$pkg" ] || [ "$(echo "$pkg" | wc -l | tr -d ' ')" != 1 ]; then
    echo "cannot tell which @orca-so/whirlpools-core the bundle holds (found: ${pkg:-none}); $wasm not copied"
    exit 1
  fi
  local src="$REPO/$pkg/dist/nodejs/$wasm"
  [ -f "$src" ] || { echo "$wasm not found at $src (run pnpm install)"; exit 1; }
  cp "$src" "$(dirname "$bundle")/$wasm"
  echo "copied $src -> $(dirname "$bundle")/$wasm"
}
install_job() {
  local name=$1 label=$2 node_args=$3 banner_extra=$4; shift 4
  local out="$HOME_DIR/risk-$name.mjs"
  "$ESBUILD" "$REPO/scripts/risk/jobs/$name.ts" --bundle --platform=node \
    --format=esm --target=node22 --tsconfig="$REPO/tsconfig.json" --outfile="$out" --log-level=warning \
    --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);$banner_extra"
  "$NODE_BIN/node" --check "$out"
  echo "bundled $out ($(du -h "$out" | cut -f1))"
  local minutes=""
  for m in "$@"; do minutes+="    <dict><key>Minute</key><integer>$m</integer></dict>\n"; done
  local plist="$PLIST_DIR/$label.plist"
  sed -e "s#__LABEL__#$label#g" -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__HOME_DIR__#$HOME_DIR#g" \
    -e "s#__SCRIPT__#risk-$name#g" -e "s#__NODE_ARGS__#$node_args#g" -e "s#__MINUTES__#$minutes#" \
    "$REPO/scripts/risk/jobs/job.plist" > "$plist"
  echo "wrote $plist"
  if [ "$LOAD" = 1 ]; then
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    echo "loaded $label -> $out"
  else
    echo "not loaded (--no-load): $label"
  fi
  echo "log: $HOME_DIR/risk-$name.log"
}

if [ "$WANT_SPLIT" = 1 ]; then
  link_repo_folder "$REPO_SPLIT" "$DATA/split" jsonl
  install_job facts-split com.colosseum.risk-facts-split "" "" 15
fi
if [ "$WANT_LENDING" = 1 ]; then
  copy_input "$REPO/data/risk/history-full/hourly" "$DATA/history-full/hourly"
  copy_input "$REPO/data/risk/lending-history/decoded/reallocations.jsonl" \
    "$DATA/lending-history/decoded/reallocations.jsonl"
  copy_input "$REPO/data/risk/lending-history/follow/summary.json" "$DATA/lending-history/follow/summary.json"
  cp "$REPO/fixtures/risk/issuer-models.json" "$HOME_DIR/issuer-models.json"
  echo "copied $REPO/fixtures/risk/issuer-models.json -> $HOME_DIR/issuer-models.json"
  append_env RISK_ISSUER_MODELS "$HOME_DIR/issuer-models.json"
  link_repo_folder "$REPO_REPORT" "$DATA/lending-history/report" json
  # klend-sdk pulls in @orca-so/whirlpools-core (through kliquidity-sdk), which reads its .wasm beside its own file
  # through __dirname: the banner defines __filename/__dirname for the ESM bundle, and the .wasm is copied beside it.
  install_job facts-lending com.colosseum.risk-facts-lending " --max-old-space-size=8192" \
    " const __filename = import.meta.filename; const __dirname = import.meta.dirname;" 20
  copy_wasm "$HOME_DIR/risk-facts-lending.mjs"
fi
