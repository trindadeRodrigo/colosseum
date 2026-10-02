//! Account layouts, as DESIGN-VAULT.md section 3.7 lays them out. Fields for instructions
//! that do not exist yet are here with their space, so adding those instructions needs no
//! migration.

use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";

pub const MAX_POSITIONS: usize = 16;
pub const BPS: u32 = 10_000;

/// One per program, at seeds ["config"].
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Two-step hand-over; all zeros when none is pending.
    pub pending_admin: Pubkey,
    pub guardian: Pubkey,
    pub default_keeper: Pubkey,
    /// The only program a vault may swap through. Never fixed in code: Jupiter on mainnet,
    /// the test exchange on devnet.
    pub router_program: Pubkey,
    /// The program that must own a price account. Never fixed in code: Kamino Scope on
    /// mainnet, the test price program on devnet.
    pub price_owner: Pubkey,
    pub keeper_paused: bool,
    /// One-way; raises the floor on `publish_delay_s`.
    pub launched: bool,
    pub tolerance_bps: u16,
    pub loss_cap_bps: u16,
    pub band_bps: u16,
    pub twap_dev_bps: u16,
    pub max_price_age_s: u16,
    pub asset_cooldown_s: u32,
    pub publish_delay_s: u32,
    pub session_open_utc_s: u32,
    pub session_close_utc_s: u32,
    pub closed_until: i64,
    /// Days since 1970, UTC.
    pub closed_days: [u16; 32],
    pub reserved: [u8; 64],
}

/// The keeper and registry settings an admin chooses, within the hard bounds in `checks`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Params {
    pub tolerance_bps: u16,
    pub loss_cap_bps: u16,
    pub band_bps: u16,
    pub twap_dev_bps: u16,
    pub max_price_age_s: u16,
    pub asset_cooldown_s: u32,
    pub publish_delay_s: u32,
    pub session_open_utc_s: u32,
    pub session_close_utc_s: u32,
}

/// One per owner per plan, at seeds ["vault", owner, basket_id as u64 LE]. It stores the
/// state and is the authority of the vault's token accounts.
///
/// Borsh. The field order is frozen: `owner` is at byte 8, `recipe` at 40,
/// `accepted_version` at 72 and `auto_follow` at 76, and other code filters on them.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    /// The shared portfolio this vault follows; all zeros when it follows none.
    pub recipe: Pubkey,
    pub accepted_version: u32,
    pub auto_follow: bool,
    pub basket_id: u64,
    pub bump: u8,
    /// All zeros means Config's default keeper.
    pub keeper: Pubkey,
    /// How many of `positions` are in use.
    pub count: u8,
    pub positions: [Position; MAX_POSITIONS],
    pub loss_accum: u64,
    pub loss_ts: i64,
    /// Byte 0 is the vault type; 0 is the standard vault.
    pub reserved: [u8; 128],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Position {
    pub mint: Pubkey,
    pub target_bps: u16,
    /// The balance last seen in the vault's token account for this mint. A hint: an issuer
    /// with a permanent delegate, or anyone sending tokens in, changes the real balance.
    pub tracked: u64,
    pub last_keeper_ts: i64,
}

/// One line of a vault's targets.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Target {
    pub mint: Pubkey,
    pub target_bps: u16,
}

impl Vault {
    /// Records the balance now held for `mint`, if the mint is one of the positions.
    pub fn record_balance(&mut self, mint: &Pubkey, amount: u64) {
        let count = self.count as usize;
        if let Some(position) = self
            .positions
            .iter_mut()
            .take(count)
            .find(|position| position.mint == *mint)
        {
            position.tracked = amount;
        }
    }
}
