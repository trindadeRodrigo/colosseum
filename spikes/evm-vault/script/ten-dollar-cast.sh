#!/usr/bin/env bash
# Real-money smoke test, about $10, with forge create + cast send (no local EVM simulation, so it
# also works on Base where B20 tokens are precompiles). The signer is owner and keeper.
#
#   RPC=<url> SIGNER="--account <keystore-name>" ./script/ten-dollar-cast.sh rh
#   RPC=<url> SIGNER="--account <keystore-name>" ./script/ten-dollar-cast.sh base
#   DRY=1 ...            print the plan and the swap calldata, send nothing
#   KEEP=1 ...           leave the position in the vault (skip withdrawAll)
#   AMOUNT=10000000      cash in 6dp (default $10)   SLIPPAGE_BPS=100
#
# Before running: the signer needs ~$10 of cash token (USDG on rh, USDC on base) and a little ETH.
# Non-US persons only. SIGNER can also be "--ledger" or, on a local fork, "--unlocked --from <addr>".
set -euo pipefail
cd "$(dirname "$0")/.."
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
CHAIN=${1:?usage: ten-dollar-cast.sh rh|base}
: "${RPC:?set RPC}"; : "${SIGNER:?set SIGNER, e.g. --account mykey}"
AMOUNT=${AMOUNT:-10000000}; SLIPPAGE_BPS=${SLIPPAGE_BPS:-100}
ZERO=0x0000000000000000000000000000000000000000

case $CHAIN in
  rh)   WANT=4663; CASH=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; STOCK=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
        CASH_FEED=0x61B7e5650328764B076A108EFF5fa7282a1B9aD2; STOCK_FEED=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
        ROUTER=0x204FAca1764B154221e35c0d20aBb3c525710498; PULL=2; STOCK_DEC=18 ;;
  base) WANT=8453; CASH=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; STOCK=0xb20000000000000000000078ee7ce2fE4908108C
        CASH_FEED=0x7e860098F58bBFC8648a4311b374B1D669a2bc6B; STOCK_FEED=0x04689a41629776563E6822F76f2e57D148d28513
        POOL=0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9; ROUTER=""; PULL=1; STOCK_DEC=8 ;;
  *) echo "unknown chain"; exit 1 ;;
esac
[ "$(cast chain-id --rpc-url "$RPC")" = "$WANT" ] || { echo "RPC is not chain $WANT"; exit 1; }
ME=$(cast wallet address $SIGNER 2>/dev/null || echo "${SIGNER##*--from }")
echo "signer $ME  cash balance $(cast call $CASH 'balanceOf(address)(uint256)' $ME --rpc-url "$RPC")"

PX=$(cast call $STOCK_FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC" | sed -n 2p | awk '{print $1}')
MINOUT=$(node -e "console.log((BigInt('$AMOUNT')*10n**BigInt($STOCK_DEC+8-6)/BigInt('$PX')*BigInt(10000-$SLIPPAGE_BPS)/10000n).toString())")
echo "feed price (8dp) $PX  amount $AMOUNT  minOut (raw) $MINOUT"
[ -n "${DRY:-}" ] && echo "DRY: would deploy${ROUTER:+ nothing but} the vault, approve, deposit, keeperSwap, withdrawAll"

send() { [ -n "${DRY:-}" ] && { echo "DRY cast send $*"; return; }; cast send "$@" --rpc-url "$RPC" $SIGNER --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("  tx",r.transactionHash,"status",r.status,"gasUsed",parseInt(r.gasUsed,16))})'; }
create() { forge create --rpc-url "$RPC" $SIGNER --broadcast --json "$@" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("{"))).deployedTo))'; }

if [ -z "${DRY:-}" ]; then
  if [ -z "$ROUTER" ]; then ROUTER=$(create src/SlipstreamAdapter.sol:SlipstreamAdapter); echo "adapter $ROUTER"; fi
  VAULT=$(create src/BasketVault.sol:BasketVault --constructor-args $ME $ME "[$CASH,$STOCK]" "[$CASH_FEED,$STOCK_FEED]" "[$ROUTER]" "[$PULL]" 125 93600)
  echo "vault $VAULT"
else
  ROUTER=${ROUTER:-$ZERO}; VAULT=$ZERO
fi

if [ "$CHAIN" = rh ]; then
  DEADLINE=$(( $(date +%s) + 1800 ))
  P0=$(cast abi-encode "f(((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes))" "(($CASH,$STOCK,100,1,$ZERO),true,$AMOUNT,$MINOUT,0,0x)")
  P1=$(cast abi-encode "f(address,uint256)" $CASH $AMOUNT)
  P2=$(cast abi-encode "f(address,uint256)" $STOCK $MINOUT)
  IN0=$(cast abi-encode "f(bytes,bytes[])" 0x060c0f "[$P0,$P1,$P2]")   # SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  DATA=$(cast calldata "execute(bytes,bytes[],uint256)" 0x10 "[$IN0]" $DEADLINE)   # 0x10 = V4_SWAP
else
  DATA=$(cast calldata "swapExactIn(address,address,uint256,address)" $POOL $CASH $AMOUNT $VAULT)
fi

echo "approve";    send $CASH "approve(address,uint256)" $VAULT $AMOUNT
echo "deposit";    send $VAULT "deposit(address,uint256)" $CASH $AMOUNT
echo "keeperSwap"; send $VAULT "keeperSwap(address,address,address,uint256,uint256,bytes)" $ROUTER $CASH $STOCK $AMOUNT $MINOUT $DATA
[ -z "${DRY:-}" ] && echo "vault stock balance $(cast call $STOCK 'balanceOf(address)(uint256)' $VAULT --rpc-url "$RPC")"
if [ -z "${KEEP:-}" ]; then echo "withdrawAll"; send $VAULT "withdrawAll(address)" $ME; fi
[ -z "${DRY:-}" ] && echo "signer stock balance $(cast call $STOCK 'balanceOf(address)(uint256)' $ME --rpc-url "$RPC")"
exit 0
