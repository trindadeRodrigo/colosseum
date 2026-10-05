use anchor_lang::prelude::*;

use crate::checks::check_targets;
use crate::errors::BasketError;
use crate::events::{Followed, VaultCreated};
use crate::state::{
    AssetRegistry, Config, Recipe, Target, Vault, ASSETS_SEED, CONFIG_SEED, VAULT_SEED,
};

#[derive(Accounts)]
#[instruction(basket_id: u64)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref(), &basket_id.to_le_bytes()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,
    /// Read for the cash mint, which is never a target.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ASSETS_SEED],
        bump
    )]
    pub assets: AccountLoader<'info, AssetRegistry>,
    /// The shared portfolio to follow. Left out (the program's own id in its place) for a
    /// vault with targets of its own.
    pub recipe: Option<Box<Account<'info, Recipe>>>,
    pub system_program: Program<'info, System>,
}

impl CreateVault<'_> {
    pub fn handle(
        ctx: Context<CreateVault>,
        basket_id: u64,
        targets: Vec<Target>,
        auto_follow: bool,
        expected_version: u32,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.auto_follow = auto_follow;
        vault.basket_id = basket_id;
        vault.bump = ctx.bumps.vault;

        match &ctx.accounts.recipe {
            Some(recipe) => {
                // The vault takes the weights of the version in effect, and only if that is
                // the version the person reviewed: a create signed against version N that
                // lands after N+1 took effect fails.
                let active = recipe.active(Clock::get()?.unix_timestamp);
                require!(
                    expected_version == active.version,
                    BasketError::VersionMismatch
                );
                require!(targets.is_empty(), BasketError::InvalidTargets);
                vault.recipe = recipe.key();
                vault.accepted_version = active.version;
                vault.set_positions(
                    active
                        .components()
                        .iter()
                        .map(|component| (component.mint, component.weight_bps)),
                );
                emit!(Followed {
                    vault: vault.key(),
                    recipe: vault.recipe,
                    version: vault.accepted_version,
                });
            }
            None => {
                // No shared portfolio, so no version to match: only zero is right.
                require!(expected_version == 0, BasketError::VersionMismatch);
                check_targets(
                    &targets,
                    &*ctx.accounts.assets.load()?,
                    &ctx.accounts.config.cash_mint,
                )?;
                vault.set_positions(targets.iter().map(|t| (t.mint, t.target_bps)));
            }
        }

        emit!(VaultCreated {
            vault: vault.key(),
            owner: vault.owner,
            basket_id,
        });
        Ok(())
    }
}
