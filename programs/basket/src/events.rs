use anchor_lang::prelude::*;

/// Same name as the EVM event.
#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub basket_id: u64,
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
