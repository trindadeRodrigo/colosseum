use anchor_lang::prelude::*;

use crate::checks::{check_change, check_header, check_no_cash, check_shape, refuse_limit};
use crate::errors::BasketError;
use crate::events::{RecipePublished, VersionCancelled};
use crate::state::{
    AssetRegistry, Component, Config, Recipe, RecipeVersion, ASSETS_SEED, CONFIG_SEED, RECIPE_SEED,
};

/// Creator: the first version of a shared portfolio. It takes effect at once.
#[derive(Accounts)]
#[instruction(family_id: [u8; 32])]
pub struct PublishRecipe<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Recipe::INIT_SPACE,
        seeds = [RECIPE_SEED, creator.key().as_ref(), &family_id],
        bump
    )]
    pub recipe: Box<Account<'info, Recipe>>,
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
    pub system_program: Program<'info, System>,
}

impl PublishRecipe<'_> {
    pub fn handle(
        ctx: Context<PublishRecipe>,
        family_id: [u8; 32],
        components: Vec<Component>,
        meta_hash: [u8; 32],
        max_fee_bps: u16,
        flags: u8,
    ) -> Result<()> {
        refuse_limit(check_header(max_fee_bps, flags))?;
        refuse_limit(check_shape(&components, &*ctx.accounts.assets.load()?))?;
        // The first version has nothing to wait for and nothing to be measured against.
        refuse_limit(check_no_cash(&components, &ctx.accounts.config.cash_mint))?;

        let now = Clock::get()?.unix_timestamp;
        let recipe = &mut ctx.accounts.recipe;
        recipe.creator = ctx.accounts.creator.key();
        recipe.family_id = family_id;
        recipe.current = RecipeVersion::new(1, now, meta_hash, &components);
        recipe.last_version = 1;
        recipe.last_publish_ts = now;
        recipe.max_fee_bps = max_fee_bps;
        recipe.flags = flags;

        emit!(RecipePublished {
            recipe: recipe.key(),
            version: 1,
            creator: recipe.creator,
            components,
            effective_at: now,
            turnover_bps: 0,
            meta_hash,
        });
        Ok(())
    }
}

/// Creator: a later version. It waits one publish delay before it takes effect.
#[derive(Accounts)]
pub struct UpdateRecipe<'info> {
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator)]
    pub recipe: Box<Account<'info, Recipe>>,
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
}

impl UpdateRecipe<'_> {
    pub fn handle(
        ctx: Context<UpdateRecipe>,
        components: Vec<Component>,
        meta_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let recipe = &mut ctx.accounts.recipe;
        // A version that waited and whose time has come is the one in effect, and the one
        // this version is measured against.
        recipe.promote(now);

        refuse_limit(check_shape(&components, &*ctx.accounts.assets.load()?))?;
        let turnover_bps = refuse_limit(check_change(
            recipe.current.components(),
            &components,
            recipe.has_pending(now),
            now,
            recipe.last_publish_ts,
            config.publish_delay_s,
        ))?;
        refuse_limit(check_no_cash(&components, &config.cash_mint))?;

        let version = recipe.next_version();
        let effective_at = now.saturating_add(config.publish_delay_s as i64);
        recipe.pending = RecipeVersion::new(version, effective_at, meta_hash, &components);
        recipe.last_version = version;
        recipe.last_publish_ts = now;

        emit!(RecipePublished {
            recipe: recipe.key(),
            version,
            creator: recipe.creator,
            components,
            effective_at,
            turnover_bps,
            meta_hash,
        });
        Ok(())
    }
}

/// Creator or guardian: takes back a version that is waiting. The time of its publish
/// stays, so a cancel does not give the slot back, and so does its number: the next version
/// published takes the one after it.
#[derive(Accounts)]
pub struct CancelPending<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub recipe: Box<Account<'info, Recipe>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
}

impl CancelPending<'_> {
    pub fn handle(ctx: Context<CancelPending>) -> Result<()> {
        let by = ctx.accounts.signer.key();
        let recipe = &mut ctx.accounts.recipe;
        require!(
            by == recipe.creator || by == ctx.accounts.config.guardian,
            BasketError::NotCreatorOrGuardian
        );
        // A version whose time has come is in effect: there is nothing left to cancel.
        let now = Clock::get()?.unix_timestamp;
        require!(recipe.has_pending(now), BasketError::NoPendingVersion);

        emit!(VersionCancelled {
            recipe: recipe.key(),
            version: recipe.pending.version,
            by,
        });
        // The cancelled number is spent, also on an account written before the counter.
        recipe.last_version = recipe.last_version.max(recipe.pending.version);
        recipe.pending = RecipeVersion::default();
        Ok(())
    }
}
