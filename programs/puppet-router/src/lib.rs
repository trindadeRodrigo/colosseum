//! A hostile router, for tests only. Never deployed.
//!
//! The vault program hands a router the vault's signature and an account list. This one
//! stands in for a router that has turned on its callers: it runs whatever calls the test
//! scripted, with every privilege it was handed, so each hostile case is written in the test
//! and not here.
//!
//! Instruction data: eight bytes it ignores (the vault checks them as a selector), then calls
//! one after another until the data ends:
//!   program: u8        index, in this instruction's accounts, of the program to call
//!   count: u8          how many accounts the call takes
//!   count × (index: u8, flags: u8)   bit 0 of flags asks for a signature, bit 1 for write
//!   length: u16 LE, then that many bytes of instruction data
//!
//! It signs for one address of its own, seeds ["puppet"], which holds its token reserves and
//! some SOL. It logs the privileges of every account it was handed before it runs anything.
#![allow(unexpected_cfgs)]

use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process);

pub const SEED: &[u8] = b"puppet";

fn take<'a>(data: &mut &'a [u8], n: usize) -> Result<&'a [u8], ProgramError> {
    if data.len() < n {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (head, rest) = data.split_at(n);
    *data = rest;
    Ok(head)
}

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    for (i, account) in accounts.iter().enumerate() {
        msg!(
            "puppet: account {} signer={} writable={}",
            i,
            account.is_signer,
            account.is_writable
        );
    }
    let (_, bump) = Pubkey::find_program_address(&[SEED], program_id);
    let bump = [bump];
    let seeds: &[&[u8]] = &[SEED, &bump];

    let mut rest = data;
    take(&mut rest, 8)?;
    while !rest.is_empty() {
        let head = take(&mut rest, 2)?;
        let program = accounts
            .get(head[0] as usize)
            .ok_or(ProgramError::NotEnoughAccountKeys)?;
        let mut metas = Vec::with_capacity(head[1] as usize);
        for _ in 0..head[1] {
            let entry = take(&mut rest, 2)?;
            let account = accounts
                .get(entry[0] as usize)
                .ok_or(ProgramError::NotEnoughAccountKeys)?;
            metas.push(AccountMeta {
                pubkey: *account.key,
                is_signer: entry[1] & 1 != 0,
                is_writable: entry[1] & 2 != 0,
            });
        }
        let length = take(&mut rest, 2)?;
        let length = u16::from_le_bytes([length[0], length[1]]) as usize;
        let call = Instruction {
            program_id: *program.key,
            accounts: metas,
            data: take(&mut rest, length)?.to_vec(),
        };
        invoke_signed(&call, accounts, &[seeds])?;
    }
    Ok(())
}
