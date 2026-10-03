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
