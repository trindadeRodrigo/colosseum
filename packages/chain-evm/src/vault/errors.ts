import { CHAIN_ERROR_RETRYABLE, ChainError, CONTRACT_ERROR_CODE } from '@colosseum/schemas';
import { type Abi, BaseError, decodeErrorResult, type Hex, toFunctionSelector } from 'viem';
import {
  BASKET_VAULT_ABI,
  INDEX_REGISTRY_ABI,
  VAULT_BEACON_ABI,
  VAULT_FACTORY_ABI,
} from './generated/abi';

// A revert of one of our contracts as the code every adapter reports (`CONTRACT_ERROR_CODE`), with the
// contract's own name and numbers in the message. Errors from OpenZeppelin's code that no row maps are
// `Unknown`, named.

/** Every custom error the four contracts can raise, each once. */
const ERRORS: Abi = (() => {
  const seen = new Map<string, Abi[number]>();
  for (const abi of [BASKET_VAULT_ABI, VAULT_FACTORY_ABI, INDEX_REGISTRY_ABI, VAULT_BEACON_ABI])
    for (const item of abi as Abi)
      if (item.type === 'error') {
        const signature = `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;
        seen.set(toFunctionSelector(signature), item);
      }
  return [...seen.values()];
})();

const isCode = (name: string): name is keyof typeof CONTRACT_ERROR_CODE =>
  Object.hasOwn(CONTRACT_ERROR_CODE, name);

const shown = (value: unknown): string =>
  typeof value === 'bigint' ? value.toString() : typeof value === 'string' ? value : String(value);

/** The refusal revert data stands for. Data that is no error of these contracts is `Unknown`. */
export function revertToChainError(data: Hex | undefined): ChainError {
  if (!data || data === '0x') return new ChainError('Unknown', 'reverted with no reason');
  try {
    const { errorName, args } = decodeErrorResult({ abi: ERRORS, data });
    const message = `${errorName}(${(args ?? []).map(shown).join(', ')})`;
    if (!isCode(errorName)) return new ChainError('Unknown', message);
    const code = CONTRACT_ERROR_CODE[errorName];
    return new ChainError(code, message, CHAIN_ERROR_RETRYABLE[code]);
  } catch {
    return new ChainError('Unknown', `reverted with ${data.slice(0, 10)}`);
  }
}

/** The revert data a viem error carries, where the node gave it. */
export function revertDataOf(e: unknown): Hex | undefined {
  if (!(e instanceof BaseError)) return undefined;
  let data: Hex | undefined;
  e.walk((inner) => {
    const candidate = (inner as { data?: unknown }).data;
    if (typeof candidate === 'string' && candidate.startsWith('0x')) data = candidate as Hex;
    else if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { data?: unknown }).data === 'string'
    )
      data = (candidate as { data: Hex }).data;
    return false;
  });
  return data;
}
