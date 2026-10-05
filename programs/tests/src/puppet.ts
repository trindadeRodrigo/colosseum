import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountMeta,
  AccountRole,
  type Address,
  generateKeyPairSigner,
  getProgramDerivedAddress,
  type Instruction,
  isSignerRole,
  isWritableRole,
  lamports,
} from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { concat, discriminator, REPO_ROOT } from './env';

// The hostile router (programs/puppet-router). It runs the calls a test scripts, with every
// privilege the vault program handed it, plus the signature of one address of its own.

export type Puppet = {
  program: Address;
  /** The address the puppet signs for: it owns the puppet's token reserves and holds some SOL. */
  authority: Address;
};

/** Loads the puppet at a fresh address and gives its own address 10 SOL. */
export async function loadPuppet(svm: LiteSVM): Promise<Puppet> {
  const program = (await generateKeyPairSigner()).address;
  svm.addProgram(program, readFileSync(join(REPO_ROOT, 'target', 'deploy', 'puppet_router.so')));
  const [authority] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: ['puppet'],
  });
  svm.airdrop(authority, lamports(10_000_000_000n));
  return { program, authority };
}

/** What the puppet logged for the account at this position of its own call. */
export function puppetSaw(logs: string[], index: number): { signer: boolean; writable: boolean } {
  const line = logs.find((l) => l.includes(`puppet: account ${index} `));
  if (!line) throw new Error(`the puppet did not log account ${index}`);
  return { signer: line.includes('signer=true'), writable: line.includes('writable=true') };
}

/**
 * One instruction for the puppet that makes it run `calls` in order. The eight bytes it starts
 * with are `selector`, by default the one a vault accepts (`route_v2`).
 *
 * Its account list is every account and program the calls name, each once, writable where any
 * call writes to it. No account is marked as signing here: a signature reaches the puppet only
 * if whoever calls it passes one on. Inside, each call asks for the signatures it was built with.
 */
export function puppetInstruction(
  puppet: Puppet,
  calls: Instruction[],
  options: { selector?: Uint8Array; extra?: AccountMeta[] } = {},
): Instruction {
  const order: Address[] = [];
  const writes = new Set<Address>();
  const see = (address: Address, writable: boolean) => {
    if (!order.includes(address)) order.push(address);
    if (writable) writes.add(address);
  };
  for (const extra of options.extra ?? []) see(extra.address, isWritableRole(extra.role));
  for (const call of calls) {
    for (const account of call.accounts ?? []) see(account.address, isWritableRole(account.role));
    see(call.programAddress, false);
  }

  const parts: Uint8Array[] = [options.selector ?? discriminator('route_v2')];
  for (const call of calls) {
    const accounts = call.accounts ?? [];
    const data = new Uint8Array(call.data ?? []);
    const head = [order.indexOf(call.programAddress), accounts.length];
    for (const account of accounts)
      head.push(
        order.indexOf(account.address),
        (isSignerRole(account.role) ? 1 : 0) | (isWritableRole(account.role) ? 2 : 0),
      );
    parts.push(new Uint8Array([...head, data.length & 0xff, data.length >> 8]), data);
  }
  return {
    programAddress: puppet.program,
    accounts: order.map((address) => ({
      address,
      role: writes.has(address) ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: concat(...parts),
  };
}

/** Where an account sits in the puppet's own account list. */
export function puppetIndex(instruction: Instruction, address: Address): number {
  const index = (instruction.accounts ?? []).findIndex((a) => a.address === address);
  if (index < 0) throw new Error(`${address} is not one of the puppet's accounts`);
  return index;
}
