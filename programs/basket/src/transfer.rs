use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::AccountMeta, program::invoke_signed};
use anchor_spl::token_2022::spl_token_2022;

/// `transfer_checked` through the mint's own token program (Token or Token-2022), with any
/// extra accounts appended. A Token-2022 mint with a transfer hook needs them; with no hook
/// they are ignored. The extra accounts never carry a signature.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked_with_extra<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    extra: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut instruction = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        from.key,
        mint.key,
        to.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;
    let mut accounts = vec![from.clone(), mint.clone(), to.clone(), authority.clone()];
    for account in extra {
        instruction.accounts.push(AccountMeta {
            pubkey: *account.key,
            is_signer: false,
            is_writable: account.is_writable,
        });
        accounts.push(account.clone());
    }
    invoke_signed(&instruction, &accounts, signer_seeds).map_err(Into::into)
}
