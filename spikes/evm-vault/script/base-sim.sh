#!/usr/bin/env bash
# Read-only. Simulates the whole vault flow on Base mainnet state in one eth_call with state overrides:
#   - BaseSim runtime bytecode is placed at $SIM
#   - $SIM gets a USDC balance (FiatToken balance mapping is slot 9)
# Nothing is signed or sent.
set -euo pipefail
cd "$(dirname "$0")/.."
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=${BASE_RPC_URL:-https://mainnet.base.org}
SIM=0x5151515151515151515151515151515151515151
TO=0x000000000000000000000000000000000000bEEF
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
AMOUNT=${AMOUNT:-10000000} # 10 USDC

forge build -q
CODE=$(forge inspect BaseSim deployedBytecode)
SLOT=$(cast index address $SIM 9)
BAL=$(cast to-uint256 100000000)
DATA=$(cast calldata 'run(uint256,address)' "$AMOUNT" $TO)
REQ=$(cat <<JSON
{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[
 {"from":"0x0000000000000000000000000000000000000001","to":"$SIM","data":"$DATA","gas":"0x1c9c380"},
 "latest",
 {"$SIM":{"code":"$CODE"},"$USDC":{"stateDiff":{"$SLOT":"$BAL"}}}
]}
JSON
)
RES=$(curl -s "$RPC" -H 'content-type: application/json' -d "$REQ")
OUT=$(echo "$RES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.error){console.error(JSON.stringify(j.error).slice(0,2000));process.exit(1)}console.log(j.result)})')
echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=s.trim().slice(2);const names=["vault","feedPrice8","feedAgeSec","spentUsdc(6dp)","receivedNvdac(8dp)","execPrice8","valueBefore8","valueAfter8","gasDeployVault","gasKeeperSwap","gasWithdrawAll","vaultNvdacAfterSwap","recipientNvdacAfterWithdraw","recipientUsdcAfterWithdraw"];names.forEach((n,i)=>{const w=h.slice(i*64,(i+1)*64);console.log(n.padEnd(30),i===0?"0x"+w.slice(24):BigInt("0x"+w).toString())})})'
