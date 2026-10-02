use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::BasketError;
use crate::state::{Vault, VAULT_SEED};
use crate::transfer::transfer_checked_with_extra;

/// No Config, registry or price account: a pause or a dead feed cannot block the owner.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Box<Account<'info, Vault>>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// The associated token account for (vault, mint, the mint's own token program).
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    /// Any token account of this mint that the vault's owner owns.
    #[account(
        mut,
        constraint = destination.owner == vault.owner @ BasketError::WrongDestination
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> Withdraw<'info> {
    pub fn handle(ctx: Context<'_, '_, '_, 'info, Withdraw<'info>>, amount: u64) -> Result<()> {
        let accounts = ctx.accounts;
        let owner = accounts.vault.owner;
        let basket_id = accounts.vault.basket_id.to_le_bytes();
        let bump = [accounts.vault.bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &basket_id, &bump];

        transfer_checked_with_extra(
            &accounts.token_program.to_account_info(),
            &accounts.vault_token_account.to_account_info(),
            &accounts.mint.to_account_info(),
            &accounts.destination.to_account_info(),
            &accounts.vault.to_account_info(),
            ctx.remaining_accounts,
            amount,
            accounts.mint.decimals,
            &[seeds],
        )?;

        accounts.vault_token_account.reload()?;
        let held = accounts.vault_token_account.amount;
        accounts.vault.record_balance(&accounts.mint.key(), held);
        Ok(())
    }
}
