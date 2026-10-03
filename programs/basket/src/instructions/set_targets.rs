use anchor_lang::prelude::*;

use crate::checks::check_targets;
use crate::events::{TargetsSet, Unfollowed};
use crate::state::{AssetRegistry, Config, Target, Vault, ASSETS_SEED, CONFIG_SEED};

/// Owner: the vault's own targets. A vault that followed a shared portfolio stops following
/// it, and auto-follow goes off: from here on the weights are the owner's.
#[derive(Accounts)]
pub struct SetTargets<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
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
}

impl SetTargets<'_> {
    pub fn handle(ctx: Context<SetTargets>, targets: Vec<Target>) -> Result<()> {
        check_targets(
            &targets,
            &*ctx.accounts.assets.load()?,
            &ctx.accounts.config.cash_mint,
        )?;

        let vault = &mut ctx.accounts.vault;
        if vault.recipe != Pubkey::default() {
            emit!(Unfollowed {
                vault: vault.key(),
                recipe: vault.recipe,
            });
        }
        vault.recipe = Pubkey::default();
        vault.accepted_version = 0;
        vault.auto_follow = false;
        vault.set_positions(targets.iter().map(|t| (t.mint, t.target_bps)));

        emit!(TargetsSet {
            vault: vault.key(),
            count: vault.count,
        });
        Ok(())
    }
}
