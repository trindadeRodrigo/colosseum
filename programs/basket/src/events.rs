use anchor_lang::prelude::*;

/// Same name as the EVM event.
#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub basket_id: u64,
}
