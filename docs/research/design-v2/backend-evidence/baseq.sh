#!/usr/bin/env bash
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=${RPC:-https://mainnet.base.org}
SIM=0x5151515151515151515151515151515151515152
POOL=${POOL:-0x853f5f1b92b16714fe6cda67caad0856b83c7ab9}
FEED=${FEED:-0x04689a41629776563E6822F76f2e57D148d28513}
DEC=${DEC:-8}
ZFO=${ZFO:-false}
CODE=$(forge inspect ClQuoter deployedBytecode)
echo "block $(cast block-number --rpc-url $RPC) at $(date -u +%FT%TZ) rpc=$RPC pool=$POOL"
RD=$(cast call $FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url $RPC)
PX=$(echo "$RD" | sed -n 2p | awk '{print $1}'); UPD=$(echo "$RD" | sed -n 4p | awk '{print $1}')
echo "feed px(8dp)=$PX age=$(( $(date +%s) - UPD ))s"
AMTS=$(python3 -c "print('[' + ','.join(str(u * 10**8 * 10**$DEC // $PX) for u in (10,1000,10000,50000)) + ']')")
DATA=$(cast calldata 'quote(address,bool,uint256[])' $POOL $ZFO "$AMTS")
REQ="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$SIM\",\"data\":\"$DATA\",\"gas\":\"0x1c9c380\"},\"latest\",{\"$SIM\":{\"code\":\"$CODE\"}}]}"
RES=$(curl -s "$RPC" -H 'content-type: application/json' -d "$REQ")
R=$(echo "$RES" | jq -r '.result // empty')
if [ -z "$R" ]; then echo "ERR $(echo $RES | cut -c1-400)"; exit 1; fi
cast abi-decode 'f()(uint256[])' "$R" | python3 -c "
import sys,re
outs=[int(x) for x in re.findall(r'\d+', sys.stdin.read().split('[',1)[1].split(']')[0]) if len(x)>2 or True]
" 2>/dev/null
OUTS=$(cast abi-decode 'f()(uint256[])' "$R")
echo "raw outs: $OUTS"
