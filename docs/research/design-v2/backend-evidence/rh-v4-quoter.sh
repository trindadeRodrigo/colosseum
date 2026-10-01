#!/usr/bin/env bash
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=${RPC:-https://robinhood.drpc.org}
Q=0x8dc178efb8111bb0973dd9d722ebeff267c98f94
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
TOKEN=${TOKEN:-0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC}
FEED=${FEED:-0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15}
Z=0x0000000000000000000000000000000000000000
echo "block $(cast block-number --rpc-url $RPC) at $(date -u +%FT%TZ) rpc=$RPC"
RD=$(cast call $FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url $RPC)
PX=$(echo "$RD" | sed -n 2p | awk '{print $1}')
UPD=$(echo "$RD" | sed -n 4p | awk '{print $1}')
echo "feed px(8dp)=$PX age=$(( $(date +%s) - UPD ))s"
# currency ordering
if [[ "$(echo $USDG | tr A-F a-f)" < "$(echo $TOKEN | tr A-F a-f)" ]]; then C0=$USDG; C1=$TOKEN; ZFO=false; else C0=$TOKEN; C1=$USDG; ZFO=true; fi
for PAIR in "100:1" "500:10" "3000:60" "10000:200"; do
  FEE=${PAIR%%:*}; TS=${PAIR##*:}
  for USD in 10 1000 10000 50000; do
    AMT=$(python3 -c "print($USD * 10**8 * 10**18 // $PX)")
    RAW=$(cast call $Q 'quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))(uint256,uint256)' "(($C0,$C1,$FEE,$TS,$Z),$ZFO,$AMT,0x)" --rpc-url $RPC 2>&1)
    OUT=$(echo "$RAW" | head -1 | awk '{print $1}')
    if [[ "$OUT" =~ ^[0-9]+$ ]]; then
      python3 -c "out=$OUT/1e6; print('fee=%6d ts=%3d sell \$%6d -> %10.2f USDG  cost vs feed = %7.3f%%' % ($FEE,$TS,$USD,out,(1-out/$USD)*100))"
    else
      echo "fee=$FEE ts=$TS \$$USD ERR: $(echo "$RAW" | tr '\n' ' ' | cut -c1-200)"
    fi
  done
done
