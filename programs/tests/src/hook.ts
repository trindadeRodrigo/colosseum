import {
  type AccountMeta,
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  some,
  type TransactionSigner,
} from '@solana/kit';
import { getUpdateTransferHookInstruction } from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { expectOk, readonly, send } from './env';
import type { TestMint } from './tokens';

const addressEncoder = getAddressEncoder();

/** One extra account a hook asks Token-2022 to hand it, with the privileges it asks for. */
export type HookAccount = { address: Address; signer: boolean; writable: boolean };

/** Where Token-2022 looks for a hook's list of extra accounts. */
export async function validationAddress(hook: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: hook,
    seeds: ['extra-account-metas', addressEncoder.encode(mint)],
  });
  return pda;
}

/** Writes the hook's validation account. Layout (spl-tlv-account-resolution): the 8-byte
 * discriminator of the hook's Execute instruction, a u32 length, a u32 count, then 35 bytes
 * per entry: kind 0 (a fixed address), the address, is_signer, is_writable. */
export async function setHookAccounts(
  svm: LiteSVM,
  hook: Address,
  mint: Address,
  entries: HookAccount[],
): Promise<Address> {
  const list = new Uint8Array(4 + 35 * entries.length);
  new DataView(list.buffer).setUint32(0, entries.length, true);
  entries.forEach((entry, i) => {
    const at = 4 + 35 * i;
    list.set(addressEncoder.encode(entry.address), at + 1);
    list[at + 33] = entry.signer ? 1 : 0;
    list[at + 34] = entry.writable ? 1 : 0;
  });
  const data = new Uint8Array(12 + list.length);
  data.set([105, 37, 101, 197, 75, 251, 102, 26], 0);
  new DataView(data.buffer).setUint32(8, list.length, true);
  data.set(list, 12);

  const address = await validationAddress(hook, mint);
  svm.setAccount({
    address,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: hook,
    space: BigInt(data.length),
  });
  return address;
}

/** The issuer points an existing mint at a hook program, as it can at any time. */
export async function setHook(
  svm: LiteSVM,
  payer: TransactionSigner,
  mint: TestMint,
  hook: Address,
): Promise<void> {
  const instruction = getUpdateTransferHookInstruction({
    mint: mint.address,
    authority: mint.issuer,
    programId: some(hook),
  });
  expectOk(await send(svm, payer, [instruction]));
}

/** What a transfer of this mint must now carry besides its usual accounts: the hook
 * program, its validation account, and the accounts that one lists. */
export async function hookExtras(
  hook: Address,
  mint: Address,
  listed: AccountMeta[] = [],
): Promise<AccountMeta[]> {
  return [readonly(hook), readonly(await validationAddress(hook, mint)), ...listed];
}

/** The privileges the test hook logged for the account at this position of its call. */
export function hookSaw(logs: string[], index: number): { signer: boolean; writable: boolean } {
  const line = logs.find((l) => l.includes(`hook: account ${index} `));
  if (!line) throw new Error(`the hook did not log account ${index}`);
  return { signer: line.includes('signer=true'), writable: line.includes('writable=true') };
}
