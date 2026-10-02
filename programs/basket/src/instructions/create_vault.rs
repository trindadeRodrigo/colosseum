use anchor_lang::prelude::*;

use crate::checks::check_targets;
use crate::errors::BasketError;
use crate::events::VaultCreated;
use crate::state::{Target, Vault, VAULT_SEED};

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
        // The version a person reviewed must be the one the vault takes. No shared portfolio
        // is passed yet, so there is no version to match and only zero is right.
        require!(expected_version == 0, BasketError::VersionMismatch);
        check_targets(&targets)?;

        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.auto_follow = auto_follow;
        vault.basket_id = basket_id;
        vault.bump = ctx.bumps.vault;
        vault.count = targets.len() as u8;
        for (position, target) in vault.positions.iter_mut().zip(targets.iter()) {
            position.mint = target.mint;
            position.target_bps = target.target_bps;
        }

        emit!(VaultCreated {
            vault: vault.key(),
            owner: vault.owner,
            basket_id,
        });
        Ok(())
    }
}
