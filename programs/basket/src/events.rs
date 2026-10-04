use anchor_lang::prelude::*;

use crate::state::{Component, Params};

/// Same name as the EVM event.
#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub basket_id: u64,
}

/// The vault now follows a shared portfolio, at this version. Same name as the EVM event.
#[event]
pub struct Followed {
    pub vault: Pubkey,
    pub recipe: Pubkey,
    pub version: u32,
}

/// The vault stopped following. Same name as the EVM event.
#[event]
pub struct Unfollowed {
    pub vault: Pubkey,
    pub recipe: Pubkey,
}

/// The owner set the vault's own targets. Same name as the EVM event.
#[event]
pub struct TargetsSet {
    pub vault: Pubkey,
    pub count: u8,
}

/// A version of a shared portfolio was published. Same name and fields as the EVM event.
#[event]
pub struct RecipePublished {
    pub recipe: Pubkey,
    pub version: u32,
    pub creator: Pubkey,
    pub components: Vec<Component>,
    pub effective_at: i64,
    pub turnover_bps: u16,
    pub meta_hash: [u8; 32],
}

/// A waiting version was cancelled, by the creator or the guardian. Same name as the EVM event.
#[event]
pub struct VersionCancelled {
    pub recipe: Pubkey,
    pub version: u32,
    pub by: Pubkey,
}

/// The admin changed the program a vault may swap through.
#[event]
pub struct RouterSet {
    pub old: Pubkey,
    pub new: Pubkey,
}

/// The admin changed the program that must own a price account.
#[event]
pub struct PriceOwnerSet {
    pub old: Pubkey,
    pub new: Pubkey,
}

/// The admin changed the mint a vault takes as a deposit.
#[event]
pub struct CashMintSet {
    pub old: Pubkey,
    pub new: Pubkey,
}

/// The admin changed the parameters.
#[event]
pub struct ParamsSet {
    pub params: Params,
}

/// The one-way switch was thrown: the three addresses are locked and the publish delay is
/// at least two days.
#[event]
pub struct Launched {
    pub publish_delay_s: u32,
}

/// Same name as the EVM event.
#[event]
pub struct AdminProposed {
    pub pending_admin: Pubkey,
}

/// Same name as the EVM event.
#[event]
pub struct AdminChanged {
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
}

/// The keeper paths were stopped (by the guardian) or started again (by the admin).
#[event]
pub struct KeeperPauseSet {
    pub paused: bool,
}

/// The admin listed a token or changed its entry. Same name as the EVM event.
#[event]
pub struct AssetSet {
    pub mint: Pubkey,
    pub index: u8,
    pub max_weight_bps: u16,
}

/// The admin changed the guardian. Same name as the EVM event.
#[event]
pub struct GuardianSet {
    pub old: Pubkey,
    pub new: Pubkey,
}

/// The admin changed the default keeper. Same name as the EVM event.
#[event]
pub struct KeeperSet {
    pub old: Pubkey,
    pub new: Pubkey,
}

/// The time before which the market counts as closed was set, by the admin or (later only)
/// by the guardian. Same name as the EVM event.
#[event]
pub struct ClosedUntilSet {
    pub closed_until: i64,
}

/// A day (days since 1970, UTC) was closed, by the admin or the guardian, or opened again
/// by the admin. Same name as the EVM event.
#[event]
pub struct ClosedDaySet {
    pub day: u16,
    pub closed: bool,
}

/// The admin named the price account of a slot of the asset list.
#[event]
pub struct PriceAccountSet {
    pub slot: u8,
    pub old: Pubkey,
    pub new: Pubkey,
}

/// The owner switched auto-follow.
#[event]
pub struct AutoFollowSet {
    pub vault: Pubkey,
    pub on: bool,
}

/// An auto-follow vault took a version that only changes weights, with no signature from
/// its owner. Same name as the EVM event.
#[event]
pub struct VersionAdopted {
    pub vault: Pubkey,
    pub recipe: Pubkey,
    pub version: u32,
}

/// One trade by the keeper, as the vault measured it on its own token accounts. `loss` is
/// what the leg lost at the reference price and `loss_used_bps` what the weekly counter
/// then holds, as a share of the vault's value; `loss` is in raw units of the cash mint.
/// Same name as the EVM event.
#[event]
pub struct KeeperTrade {
    pub vault: Pubkey,
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub spent: u64,
    pub received: u64,
    pub loss: u64,
    pub loss_used_bps: u16,
}
