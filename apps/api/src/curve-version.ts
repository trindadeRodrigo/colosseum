// The method version an asset's stored curves are read under (risk_depth_curves). No I/O.
// A Solana asset's curve is routed across its pools (risk-0.3). A stock on an EVM chain is measured by
// the EVM collector, best single pool per size, and its curve keeps that collector's version (evmq-0.1;
// scripts/risk-evm, PLAN-UNIVERSE RU.8). The address says which: base58 has no `0`, so no Solana address
// starts with `0x`. Reading by the address, not by whichever rows are there, keeps a curve written for an
// EVM address under the Solana name from ever being served.
export const RISK_METHOD_VERSION = 'risk-0.3';
export const EVM_METHOD_VERSION = 'evmq-0.1';
export const CURVE_METHOD_VERSIONS = [RISK_METHOD_VERSION, EVM_METHOD_VERSION];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const curveVersionOf = (address: string): string =>
  EVM_ADDRESS.test(address) ? EVM_METHOD_VERSION : RISK_METHOD_VERSION;

/** How a curve is matched to an asset: an EVM address in lower case, any other address as it is. */
export const curveKey = (address: string): string =>
  EVM_ADDRESS.test(address) ? address.toLowerCase() : address;
