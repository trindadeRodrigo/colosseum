//! The rules, as plain functions. Each one has a test that fails when it is removed.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::StateWithExtensions, state::Account as TokenAccountState,
};

use crate::errors::BasketError;
use crate::state::{AssetRegistry, Component, Params, Target, BPS, MAX_COMPONENTS, MAX_POSITIONS};

// Hard bounds (DESIGN-VAULT.md section 3.7). The numbers the app shows cannot move past
// these without an upgrade.
pub const MAX_TOLERANCE_BPS: u16 = 300;
pub const MAX_LOSS_CAP_BPS: u16 = 500;
pub const MAX_BAND_BPS: u16 = 500;
pub const MAX_TWAP_DEV_BPS: u16 = 1_000;
pub const MAX_PRICE_AGE_S: u16 = 600;
pub const MIN_ASSET_COOLDOWN_S: u32 = 600;
pub const MIN_PUBLISH_DELAY_S: u32 = 60;
/// The floor on the publish delay once `launch()` has run: two days.
pub const LAUNCHED_PUBLISH_DELAY_S: u32 = 172_800;
/// 13:30 UTC, the New York open in summer time: no session opens before it.
pub const MIN_SESSION_OPEN_UTC_S: u32 = 48_600;
/// 21:00 UTC, the New York close in winter time: no session closes after it.
pub const MAX_SESSION_CLOSE_UTC_S: u32 = 75_600;

pub fn check_params(params: &Params, launched: bool) -> Result<()> {
    require!(
        params.tolerance_bps <= MAX_TOLERANCE_BPS,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.loss_cap_bps <= MAX_LOSS_CAP_BPS,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.band_bps <= MAX_BAND_BPS,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.twap_dev_bps <= MAX_TWAP_DEV_BPS,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.max_price_age_s <= MAX_PRICE_AGE_S,
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
    require!(
        !launched || params.publish_delay_s >= LAUNCHED_PUBLISH_DELAY_S,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.session_open_utc_s >= MIN_SESSION_OPEN_UTC_S,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.session_close_utc_s <= MAX_SESSION_CLOSE_UTC_S,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.session_open_utc_s < params.session_close_utc_s,
        BasketError::ParamOutOfBounds
    );
    Ok(())
}

/// An address the admin sets in Config. All zeros is the empty value, and it is also the
/// system program's id: never a router, a price program, a mint, a guardian or a keeper.
pub fn check_address(address: &Pubkey) -> Result<()> {
    require!(*address != Pubkey::default(), BasketError::ZeroAddress);
    Ok(())
}

/// The program a vault signs a swap for. A token program would take the vault's signature
/// as leave to move, approve or reassign its tokens; the system program and this program
/// are never an exchange.
pub fn check_router(router: &Pubkey) -> Result<()> {
    require!(
        *router != anchor_spl::token::ID,
        BasketError::RouterNotAllowed
    );
    require!(
        *router != anchor_spl::token_2022::ID,
        BasketError::RouterNotAllowed
    );
    require!(
        *router != anchor_lang::system_program::ID,
        BasketError::RouterNotAllowed
    );
    require!(*router != crate::ID, BasketError::RouterNotAllowed);
    Ok(())
}

/// The first eight bytes of the four router instructions a vault may send: Anchor's
/// selectors for `route`, `shared_accounts_route`, `route_v2` and `shared_accounts_route_v2`.
pub const ROUTE_SELECTORS: [[u8; 8]; 4] = [
    [229, 23, 203, 151, 122, 227, 173, 42],
    [193, 32, 155, 51, 65, 214, 156, 129],
    [187, 100, 250, 204, 49, 196, 175, 20],
    [209, 152, 83, 147, 124, 254, 216, 233],
];

/// The router is called for a swap and nothing else.
pub fn check_route_selector(data: &[u8]) -> Result<()> {
    require!(
        data.len() >= 8 && ROUTE_SELECTORS.iter().any(|s| s[..] == data[..8]),
        BasketError::RouterNotAllowed
    );
    Ok(())
}

/// A vault's own targets: they fit the vault, name each mint once, never the zero address
/// (it marks an empty slot), and add up to at most the whole (what is left is cash). Each
/// mint is on the platform list and none is the cash mint, which is never a position.
pub fn check_targets(
    targets: &[Target],
    registry: &AssetRegistry,
    cash_mint: &Pubkey,
) -> Result<()> {
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
        require!(target.mint != *cash_mint, BasketError::MintNotAccepted);
        require!(
            registry.is_listed(&target.mint),
            BasketError::MintNotAccepted
        );
        total = total.saturating_add(target.target_bps as u32);
    }
    require!(total <= BPS, BasketError::InvalidTargets);
    Ok(())
}

// ---- the author limits (DESIGN-VAULT.md section 6, fixtures/creator-limits) ----

pub const MIN_COMPONENTS: usize = 3;
pub const MIN_WEIGHT_BPS: u16 = 200;
/// No asset is above 50%, whatever its own ceiling.
pub const MAX_WEIGHT_BPS: u16 = 5_000;
pub const WEIGHT_STEP_BPS: u16 = 50;
/// A version moves at most 20% of the portfolio. The limit is on the sum of the absolute
/// weight changes, which is twice that, so nothing is divided.
pub const MAX_MOVED_BPS: u32 = 4_000;

/// Why a version is refused. The numbers are those of fixtures/creator-limits/README.md,
/// and a refusal names the lowest one the version breaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LimitReason {
    FeeNotZero = 1,
    FlagsNotZero = 2,
    TooFewAssets = 3,
    TooManyAssets = 4,
    AssetNotListed = 5,
    DuplicateAsset = 6,
    WeightBelowMin = 7,
    WeightOffStep = 8,
    WeightAboveCeiling = 9,
    WeightSum = 10,
    VersionPending = 11,
    VersionTooSoon = 12,
    TurnoverTooHigh = 13,
    CashNotAllowed = 14,
}

/// Rules 1 and 2: the two values a first publish carries beside the weights.
pub fn check_header(max_fee_bps: u16, flags: u8) -> core::result::Result<(), LimitReason> {
    if max_fee_bps != 0 {
        return Err(LimitReason::FeeNotZero);
    }
    if flags != 0 {
        return Err(LimitReason::FlagsNotZero);
    }
    Ok(())
}

/// Rules 3 to 10, which every version is held to whether a weight changed or not.
pub fn check_shape(
    next: &[Component],
    registry: &AssetRegistry,
) -> core::result::Result<(), LimitReason> {
    if next.len() < MIN_COMPONENTS {
        return Err(LimitReason::TooFewAssets);
    }
    if next.len() > MAX_COMPONENTS {
        return Err(LimitReason::TooManyAssets);
    }
    if next.iter().any(|c| !registry.is_listed(&c.mint)) {
        return Err(LimitReason::AssetNotListed);
    }
    if (1..next.len()).any(|i| next[..i].iter().any(|other| other.mint == next[i].mint)) {
        return Err(LimitReason::DuplicateAsset);
    }
    if next.iter().any(|c| c.weight_bps < MIN_WEIGHT_BPS) {
        return Err(LimitReason::WeightBelowMin);
    }
    if next.iter().any(|c| c.weight_bps % WEIGHT_STEP_BPS != 0) {
        return Err(LimitReason::WeightOffStep);
    }
    if next
        .iter()
        .any(|c| c.weight_bps > ceiling_bps(registry, &c.mint))
    {
        return Err(LimitReason::WeightAboveCeiling);
    }
    if next.iter().map(|c| c.weight_bps as u32).sum::<u32>() != BPS {
        return Err(LimitReason::WeightSum);
    }
    Ok(())
}

/// The ceiling of one asset: 50%, or its own `max_weight_bps` when that is lower. An asset
/// that is not listed has none.
pub fn ceiling_bps(registry: &AssetRegistry, mint: &Pubkey) -> u16 {
    let own = registry.find(mint).map_or(0, |entry| entry.max_weight_bps);
    own.min(MAX_WEIGHT_BPS)
}

/// Rules 11 to 13, for a version that follows another. `prev` is the version in effect.
/// Answers the turnover in bps: half of what moved.
pub fn check_change(
    prev: &[Component],
    next: &[Component],
    has_pending: bool,
    now: i64,
    last_publish_ts: i64,
    publish_delay_s: u32,
) -> core::result::Result<u16, LimitReason> {
    if has_pending {
        return Err(LimitReason::VersionPending);
    }
    if now < last_publish_ts.saturating_add(publish_delay_s as i64) {
        return Err(LimitReason::VersionTooSoon);
    }
    let moved = moved_bps(prev, next);
    if moved > MAX_MOVED_BPS {
        return Err(LimitReason::TurnoverTooHigh);
    }
    Ok(moved.div_ceil(2) as u16)
}

/// The sum of the absolute weight changes over every asset in either version. An added
/// asset counts from zero and a removed one to zero.
pub fn moved_bps(prev: &[Component], next: &[Component]) -> u32 {
    let weight_in = |list: &[Component], mint: &Pubkey| {
        list.iter()
            .find(|c| c.mint == *mint)
            .map_or(0, |c| c.weight_bps as u32)
    };
    let changed: u32 = next
        .iter()
        .map(|n| (n.weight_bps as u32).abs_diff(weight_in(prev, &n.mint)))
        .sum();
    let removed: u32 = prev
        .iter()
        .filter(|p| next.iter().all(|n| n.mint != p.mint))
        .map(|p| p.weight_bps as u32)
        .sum();
    changed + removed
}

/// Rule 14: a shared portfolio holds assets, never the chain's cash token.
pub fn check_no_cash(
    next: &[Component],
    cash_mint: &Pubkey,
) -> core::result::Result<(), LimitReason> {
    if next.iter().any(|c| c.mint == *cash_mint) {
        return Err(LimitReason::CashNotAllowed);
    }
    Ok(())
}

/// Every refusal by the author limits is the one error, `CreatorLimit`. Which rule it was
/// goes in the log, as its number.
pub fn refuse_limit<T>(result: core::result::Result<T, LimitReason>) -> Result<T> {
    result.map_err(|reason| {
        msg!("creator limit: reason={} {:?}", reason as u8, reason);
        error!(BasketError::CreatorLimit)
    })
}

// ---- a vault's token accounts, around a swap ----

/// What the program reads of a token account, of either token program.
pub struct TokenView {
    pub owner: Pubkey,
    pub amount: u64,
    pub has_delegate: bool,
    pub has_close_authority: bool,
    pub data_len: usize,
}

/// The account as a token account, or None when it is not one: another program's account,
/// a mint, a multisig, or space that was never initialised.
pub fn token_view(account: &AccountInfo) -> Option<TokenView> {
    if *account.owner != anchor_spl::token::ID && *account.owner != anchor_spl::token_2022::ID {
        return None;
    }
    let data = account.try_borrow_data().ok()?;
    let state = StateWithExtensions::<TokenAccountState>::unpack(&data).ok()?;
    Some(TokenView {
        owner: state.base.owner,
        amount: state.base.amount,
        has_delegate: state.base.delegate.is_some(),
        has_close_authority: state.base.close_authority.is_some(),
        data_len: data.len(),
    })
}

/// The account list a router is handed may hold two token accounts the vault owns: the one
/// the swap spends from and the one it pays into. The vault's signature reaches every
/// program on the route, so any other one could be emptied, lent out or given away.
pub fn refuse_other_vault_accounts(
    accounts: &[AccountInfo],
    vault: &Pubkey,
    input: &Pubkey,
    output: &Pubkey,
) -> Result<()> {
    for account in accounts {
        if account.key == input || account.key == output {
            continue;
        }
        require!(
            token_view(account).is_none_or(|token| token.owner != *vault),
            BasketError::AccountTampered
        );
    }
    Ok(())
}

/// One of the swap's two token accounts after the router ran: still a token account of the
/// same size that the vault owns, with nobody else allowed to spend from it or close it.
/// Answers its balance.
pub fn check_untampered(account: &AccountInfo, before: &TokenView, vault: &Pubkey) -> Result<u64> {
    // Closed, or handed to another program: there is no token account here any more.
    let Some(after) = token_view(account) else {
        return err!(BasketError::AccountTampered);
    };
    require!(after.owner == *vault, BasketError::AccountTampered);
    require!(!after.has_delegate, BasketError::AccountTampered);
    require!(!after.has_close_authority, BasketError::AccountTampered);
    require!(
        after.data_len == before.data_len,
        BasketError::AccountTampered
    );
    Ok(after.amount)
}
