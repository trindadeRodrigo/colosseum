use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

use crate::checks::token_view;
use crate::errors::BasketError;
use crate::state::Vault;

/// Anyone: writes what the vault's own token accounts hold into `tracked`. A keeper leg
/// values the positions it does not trade by `tracked`, and a token sent in from outside,
/// or taken by an issuer, moves the balance without the program seeing it.
///
/// The accounts after the vault are the token accounts to read. Each has to be the vault's
/// associated token account for one of its positions: the one account the program uses for
/// that mint.
#[derive(Accounts)]
pub struct SyncBalances<'info> {
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
}

impl<'info> SyncBalances<'info> {
    pub fn handle(ctx: Context<'_, '_, '_, 'info, SyncBalances<'info>>) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        for account in ctx.remaining_accounts {
            let token = token_view(account).ok_or(BasketError::AccountTampered)?;
            require!(token.owner == vault_key, BasketError::AccountTampered);
            let own = get_associated_token_address_with_program_id(
                &vault_key,
                &token.mint,
                account.owner,
            );
            require!(own == *account.key, BasketError::AccountTampered);
            require!(
                ctx.accounts.vault.position(&token.mint).is_some(),
                BasketError::MintNotAccepted
            );
            ctx.accounts.vault.record_balance(&token.mint, token.amount);
        }
        Ok(())
    }
}
