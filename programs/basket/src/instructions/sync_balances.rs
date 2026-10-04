use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

use crate::checks::{check_keeper, token_view};
use crate::errors::BasketError;
use crate::state::{Config, Vault, CONFIG_SEED};

/// The vault's owner or its keeper: writes what the vault's own token accounts hold into
/// `tracked`. A keeper leg values the positions it does not trade by `tracked`, and a token
/// sent in from outside, or taken by an issuer, moves the balance without the program
/// seeing it.
///
/// Not anyone. A leg holds every position with a recorded balance to its price reference,
/// so whoever can have a balance recorded can stop the keeper for a vault with one raw unit
/// of an asset that has no reference now, and can move the weights with a gift.
///
/// The accounts after Config are the token accounts to read. Each has to be the vault's
/// associated token account for one of its positions: the one account the program uses for
/// that mint.
#[derive(Accounts)]
pub struct SyncBalances<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
}

impl<'info> SyncBalances<'info> {
    pub fn handle(ctx: Context<'_, '_, '_, 'info, SyncBalances<'info>>) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        let signer = ctx.accounts.signer.key();
        if signer != ctx.accounts.vault.owner {
            check_keeper(&signer, &ctx.accounts.vault, &ctx.accounts.config)?;
        }
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
