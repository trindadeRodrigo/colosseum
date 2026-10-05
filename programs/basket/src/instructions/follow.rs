use anchor_lang::prelude::*;

use crate::errors::BasketError;
use crate::events::{AutoFollowSet, Followed, Unfollowed, VersionAdopted};
use crate::state::{Config, Recipe, Vault, CONFIG_SEED};

/// Owner: takes the version in effect of a shared portfolio, the one the vault follows or
/// another. This is the owner's consent to the weights of that version, and the only way a
/// new asset comes into a vault that follows.
#[derive(Accounts)]
pub struct AcceptVersion<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Box<Account<'info, Vault>>,
    pub recipe: Box<Account<'info, Recipe>>,
}

impl AcceptVersion<'_> {
    pub fn handle(ctx: Context<AcceptVersion>, expected_version: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let recipe = &ctx.accounts.recipe;
        // A number names one set of weights for good, so the number is the consent. The
        // version that waits has its number and is not in effect yet.
        require!(
            !(recipe.has_pending(now) && recipe.pending.version == expected_version),
            BasketError::VersionNotEffective
        );
        // The version in effect is the one the person reviewed: an accept signed against
        // version N that lands after N+1 took effect fails.
        let active = recipe.active(now);
        require!(
            expected_version == active.version,
            BasketError::VersionMismatch
        );

        let vault = &mut ctx.accounts.vault;
        let recipe_key = recipe.key();
        if vault.recipe != Pubkey::default() && vault.recipe != recipe_key {
            emit!(Unfollowed {
                vault: vault.key(),
                recipe: vault.recipe,
            });
        }
        vault.take_version(active)?;
        vault.recipe = recipe_key;
        vault.accepted_version = active.version;
        emit!(Followed {
            vault: vault.key(),
            recipe: recipe_key,
            version: active.version,
        });
        Ok(())
    }
}

/// Anyone: moves an auto-follow vault to the version in effect of the portfolio it
/// follows, when that version only changes weights among assets the owner has accepted.
/// It is a keeper path: the guardian's pause stops it.
#[derive(Accounts)]
pub struct AdoptVersion<'info> {
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
    /// The shared portfolio the vault follows, and no other.
    #[account(address = vault.recipe)]
    pub recipe: Box<Account<'info, Recipe>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
}

impl AdoptVersion<'_> {
    pub fn handle(ctx: Context<AdoptVersion>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.auto_follow, BasketError::AutoFollowOff);
        require!(
            !ctx.accounts.config.keeper_paused,
            BasketError::KeeperPaused
        );
        let active = ctx.accounts.recipe.active(Clock::get()?.unix_timestamp);
        // Nothing newer than what the vault holds is in effect: a version that waits is not.
        require!(
            active.version > vault.accepted_version,
            BasketError::VersionNotEffective
        );
        // An asset the owner never accepted comes in only with the owner's signature.
        require!(
            active.components().iter().all(|c| vault.accepts(&c.mint)),
            BasketError::NewAssetNeedsOwner
        );
        vault.take_version(active)?;
        vault.accepted_version = active.version;
        emit!(VersionAdopted {
            vault: vault.key(),
            recipe: vault.recipe,
            version: active.version,
        });
        Ok(())
    }
}

/// Owner: lets the keeper trade the vault toward its targets, or stops it.
#[derive(Accounts)]
pub struct SetAutoFollow<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Box<Account<'info, Vault>>,
}

impl SetAutoFollow<'_> {
    pub fn handle(ctx: Context<SetAutoFollow>, on: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.auto_follow = on;
        emit!(AutoFollowSet {
            vault: vault.key(),
            on,
        });
        Ok(())
    }
}
