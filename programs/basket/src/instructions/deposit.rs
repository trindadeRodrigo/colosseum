use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::BasketError;
use crate::state::{Config, Vault, CONFIG_SEED};
use crate::transfer::transfer_checked_with_extra;

/// Money comes into a vault as the chain's dollar token only. A token sent to the vault's
/// address from outside cannot be stopped; `withdraw` takes it out again.
#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner)]
    pub vault: Box<Account<'info, Vault>>,
    /// Read for the cash mint. Only the one Config, at its own address.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mint::token_program = token_program,
        constraint = mint.key() == config.cash_mint @ BasketError::NotCashMint
    )]
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
    /// Cash is not a position, so nothing is recorded in the vault: what it holds in cash
    /// is the balance of its token account.
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
        )
    }
}
