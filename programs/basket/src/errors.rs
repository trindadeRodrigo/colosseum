use anchor_lang::prelude::*;

/// The order is frozen and the list only grows at the end: clients and the EVM contracts
/// name the same cases, and Anchor numbers them from 6000.
#[error_code]
pub enum BasketError {
    #[msg("signer is not the vault's keeper")]
    NotKeeper,
    #[msg("auto-follow is off for this vault")]
    AutoFollowOff,
    #[msg("the keeper is paused")]
    KeeperPaused,
    #[msg("mint is not one of the vault's assets")]
    MintNotAccepted,
    #[msg("swap target is not the allowed router")]
    RouterNotAllowed,
    #[msg("the vault spent more than max_in")]
    SpentTooMuch,
    #[msg("the vault received less than min_out")]
    ReceivedTooLittle,
    #[msg("another vault token account was debited")]
    OtherAccountDebited,
    #[msg("owner, delegate, close authority or size changed on a vault token account")]
    AccountTampered,
    #[msg("price is too old")]
    PriceStale,
    #[msg("price is too far from its average")]
    PriceDeviation,
    #[msg("the market for this asset is closed")]
    MarketClosed,
    #[msg("within the window around a multiplier change")]
    MultiplierWindow,
    #[msg("trade does not move the vault toward its targets")]
    NotTowardTarget,
    #[msg("trade would go past the target")]
    PastTarget,
    #[msg("asset was traded too recently")]
    Cooldown,
    #[msg("weekly loss cap reached")]
    LossCapReached,
    #[msg("asset has no price reference")]
    AssetNotPriced,
    #[msg("a new asset needs the owner to accept it")]
    NewAssetNeedsOwner,
    #[msg("version is not in effect yet")]
    VersionNotEffective,
    #[msg("outside the limits for a shared portfolio")]
    CreatorLimit,
    #[msg("the version is not the one that was reviewed")]
    VersionMismatch,
    #[msg("destination token account does not belong to the vault's owner")]
    WrongDestination,
    #[msg("parameter outside its hard bound")]
    ParamOutOfBounds,
    // Appended after the frozen list.
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("too many targets, a mint listed twice or left empty, or weights above 100%")]
    InvalidTargets,
    #[msg("a vault takes deposits in the cash mint only")]
    NotCashMint,
    #[msg("the zero address, which is also the system program, is not accepted here")]
    ZeroAddress,
    // Appended with the swap and the registry.
    #[msg("fixed at launch; changing it needs a program upgrade")]
    LockedAtLaunch,
    #[msg("the mint has a transfer hook program")]
    HookNotAllowed,
    #[msg("the asset list is full")]
    AssetListFull,
    #[msg("a swap needs two different mints")]
    SameMint,
    #[msg("no version is waiting")]
    NoPendingVersion,
    #[msg("signer is neither the creator nor the guardian")]
    NotCreatorOrGuardian,
    // Appended with the keeper leg.
    #[msg("a keeper leg has cash on exactly one side")]
    NotCashLeg,
    #[msg("the keeper is not switched on for this asset")]
    KeeperAssetOff,
    #[msg("price is outside the range set for this asset")]
    PriceOutOfRange,
    #[msg("a keeper leg that trades nothing")]
    NothingTraded,
}
