use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::state::Vault;
use crate::transfer::transfer_checked_with_extra;

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Box<Account<'info, Vault>>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// The one token account the vault uses for this mint: the associated token account
    /// for (vault, mint, the mint's own token program).
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// Where the tokens come from. The token program checks that the owner may move them.
    #[account(mut)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> Deposit<'info> {
    pub fn handle(ctx: Context<'_, '_, '_, 'info, Deposit<'info>>, amount: u64) -> Result<()> {
        let accounts = ctx.accounts;
        transfer_checked_with_extra(
            &accounts.token_program.to_account_info(),
            &accounts.source.to_account_info(),
            &accounts.mint.to_account_info(),
            &accounts.vault_token_account.to_account_info(),
            &accounts.owner.to_account_info(),
            ctx.remaining_accounts,
            amount,
            accounts.mint.decimals,
            &[],
        )?;

        accounts.vault_token_account.reload()?;
        let held = accounts.vault_token_account.amount;
        accounts.vault.record_balance(&accounts.mint.key(), held);
        Ok(())
    }
}
