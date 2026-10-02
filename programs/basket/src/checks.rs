//! The rules, as plain functions. Each one has a test that fails when it is removed.

use anchor_lang::prelude::*;

use crate::errors::BasketError;
use crate::state::{Params, Target, BPS, MAX_POSITIONS};

// Hard bounds (DESIGN-VAULT.md section 3.7). The numbers the app shows cannot move past
// these without an upgrade. The 172,800 s floor on the publish delay after `launch()`
// arrives with `launch()`.
pub const MAX_TOLERANCE_BPS: u16 = 300;
pub const MAX_LOSS_CAP_BPS: u16 = 500;
pub const MIN_ASSET_COOLDOWN_S: u32 = 600;
pub const MIN_PUBLISH_DELAY_S: u32 = 60;

pub fn check_params(params: &Params) -> Result<()> {
    require!(
        params.tolerance_bps <= MAX_TOLERANCE_BPS,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.loss_cap_bps <= MAX_LOSS_CAP_BPS,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.asset_cooldown_s >= MIN_ASSET_COOLDOWN_S,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.publish_delay_s >= MIN_PUBLISH_DELAY_S,
        BasketError::ParamOutOfBounds
    );
    Ok(())
}

/// An address the admin sets in Config. All zeros is the empty value, and it is also the
/// system program's id: never a router, a price program or a mint.
pub fn check_address(address: &Pubkey) -> Result<()> {
    require!(*address != Pubkey::default(), BasketError::ZeroAddress);
    Ok(())
}

/// A vault's own targets: they fit the vault, name each mint once, never the zero address
/// (it marks an empty slot), and add up to at most the whole (what is left is cash).
pub fn check_targets(targets: &[Target]) -> Result<()> {
    require!(targets.len() <= MAX_POSITIONS, BasketError::InvalidTargets);
    let mut total: u32 = 0;
    for (i, target) in targets.iter().enumerate() {
        require!(
            target.mint != Pubkey::default(),
            BasketError::InvalidTargets
        );
        require!(
            targets[..i].iter().all(|other| other.mint != target.mint),
            BasketError::InvalidTargets
        );
        total = total.saturating_add(target.target_bps as u32);
    }
    require!(total <= BPS, BasketError::InvalidTargets);
    Ok(())
}
