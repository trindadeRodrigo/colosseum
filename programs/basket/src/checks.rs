//! The rules, as plain functions. Each one has a test that fails when it is removed.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::StateWithExtensions, state::Account as TokenAccountState,
};

use crate::errors::BasketError;
use crate::state::{
    AssetRegistry, Component, Config, Params, Target, Vault, BPS, MAX_COMPONENTS, MAX_POSITIONS,
};

// Hard bounds (DESIGN-VAULT.md section 3.7). The numbers the app shows cannot move past
// these without an upgrade.
pub const MAX_TOLERANCE_BPS: u16 = 300;
pub const MAX_LOSS_CAP_BPS: u16 = 500;
pub const MAX_BAND_BPS: u16 = 500;
pub const MAX_TWAP_DEV_BPS: u16 = 1_000;
pub const MAX_PRICE_AGE_S: u16 = 600;
pub const MIN_ASSET_COOLDOWN_S: u32 = 600;
/// Seven days, the window of the loss cap: a longer cooldown is a pause by another name.
pub const MAX_ASSET_COOLDOWN_S: u32 = 604_800;
pub const MIN_PUBLISH_DELAY_S: u32 = 60;
/// Thirty days, the ceiling of the EVM registry: past it no author could publish again.
pub const MAX_PUBLISH_DELAY_S: u32 = 2_592_000;
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
        params.asset_cooldown_s <= MAX_ASSET_COOLDOWN_S,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.publish_delay_s >= MIN_PUBLISH_DELAY_S,
        BasketError::ParamOutOfBounds
    );
    require!(
        params.publish_delay_s <= MAX_PUBLISH_DELAY_S,
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
/// system program's id: never a router, a price program, a guardian or a keeper. The cash
/// mint is not checked here: it comes in as an account and has to be a mint.
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

// ---- a mint's extensions ----

/// Where a Token-2022 mint's extensions start: after the base mint, its padding to the
/// length of a token account, and the byte that says "mint".
const MINT_EXTENSIONS_AT: usize = 166;
/// The extension type of a transfer hook, and the bytes of its value: an authority, then
/// the hook program.
const TRANSFER_HOOK_TYPE: u16 = 14;
const TRANSFER_HOOK_LEN: usize = 64;
/// The extension type of a scaled UI amount, and the bytes of its value: an authority, the
/// multiplier (f64), the time a new one applies from (i64), the new multiplier (f64).
const SCALED_UI_AMOUNT_TYPE: u16 = 25;
const SCALED_UI_AMOUNT_LEN: usize = 56;
/// A keeper leg stays away from a multiplier change by a day, before and after.
pub const MULTIPLIER_WINDOW_S: i64 = 86_400;

/// The value of the extension of type `kind` on a Token-2022 mint, or None when the mint
/// does not carry it. `data` is a mint the caller has already read as a mint.
///
/// The extensions are a list of entries: a type (u16), a length (u16), then that many
/// bytes. The list is walked here by hand and every type is stepped over by its length,
/// known or not: the token crate this program is built with stops with an error at the
/// first type newer than itself, and the stock tokens carry two of those ahead of their
/// hook. A list that cannot be read to its end is refused with `malformed`, whether or not
/// the extension was already found: it is never taken as "not there".
fn mint_extension(data: &[u8], kind: u16, malformed: BasketError) -> Result<Option<&[u8]>> {
    let mut found = None;
    let mut at = MINT_EXTENSIONS_AT;
    // Fewer than two bytes left cannot name a type: the list is over.
    while at + 2 <= data.len() {
        let entry_kind = u16::from_le_bytes([data[at], data[at + 1]]);
        // Type zero is space no extension has taken; nothing is written after it.
        if entry_kind == 0 {
            break;
        }
        if at + 4 > data.len() {
            return Err(malformed.into());
        }
        let length = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        let value = at + 4;
        if value + length > data.len() {
            return Err(malformed.into());
        }
        if entry_kind == kind && found.is_none() {
            found = Some(&data[value..value + length]);
        }
        at = value + length;
    }
    Ok(found)
}

/// True when the mint names a transfer hook program. An authority with no program is not a
/// hook: the stock tokens carry that.
pub fn mint_has_hook_program(data: &[u8]) -> Result<bool> {
    let Some(hook) = mint_extension(data, TRANSFER_HOOK_TYPE, BasketError::HookNotAllowed)? else {
        return Ok(false);
    };
    require!(
        hook.len() >= TRANSFER_HOOK_LEN,
        BasketError::HookNotAllowed
    );
    Ok(hook[32..TRANSFER_HOOK_LEN] != [0u8; 32])
}

/// True when the issuer changes the mint's multiplier within a day of `now`, before or
/// after. Around that time the price reference and the token can disagree about which
/// multiplier is in force. The two multipliers are compared as bytes: equal means no change.
pub fn mint_in_multiplier_window(data: &[u8], now: i64) -> Result<bool> {
    let Some(scaled) =
        mint_extension(data, SCALED_UI_AMOUNT_TYPE, BasketError::MultiplierWindow)?
    else {
        return Ok(false);
    };
    require!(
        scaled.len() >= SCALED_UI_AMOUNT_LEN,
        BasketError::MultiplierWindow
    );
    let mut at = [0u8; 8];
    at.copy_from_slice(&scaled[40..48]);
    let changes_at = i64::from_le_bytes(at);
    let changes = scaled[32..40] != scaled[48..56];
    Ok(changes && now.saturating_sub(changes_at).saturating_abs() < MULTIPLIER_WINDOW_S)
}

/// The two checks a keeper leg makes on the mint of the asset it trades. Only a Token-2022
/// mint has extensions.
pub fn check_keeper_mint(mint: &AccountInfo, now: i64) -> Result<()> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    // A hook the issuer set after the token was listed runs inside every transfer.
    require!(
        !mint_has_hook_program(&data)?,
        BasketError::HookNotAllowed
    );
    require!(
        !mint_in_multiplier_window(&data, now)?,
        BasketError::MultiplierWindow
    );
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
    pub mint: Pubkey,
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
        mint: state.base.mint,
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

// ---- the keeper's rules (DESIGN-VAULT.md section 5) ----

/// The window of the loss cap: what a leg loses is forgotten, a little each second, over
/// seven days.
pub const LOSS_WINDOW_S: i64 = 604_800;
const DAY_S: i64 = 86_400;

/// Check 1. The keeper of a vault is its own, if it names one, or else Config's.
pub fn check_keeper(signer: &Pubkey, vault: &Vault, config: &Config) -> Result<()> {
    let keeper = if vault.keeper == Pubkey::default() {
        config.default_keeper
    } else {
        vault.keeper
    };
    require!(*signer == keeper, BasketError::NotKeeper);
    Ok(())
}

/// Check 9, for a stock token: Monday to Friday, UTC, from the session's open up to but
/// not at its close, not on a closed day, and not before `closed_until`. The reader's
/// `marketAt` holds the same rule.
pub fn market_open(config: &Config, now: i64) -> bool {
    if now < 0 {
        return false;
    }
    let day = now / DAY_S;
    let second = now % DAY_S;
    // Day 0 was a Thursday; 0 is Sunday.
    let weekday = (day + 4) % 7;
    let in_session = (1..=5).contains(&weekday)
        && second >= config.session_open_utc_s as i64
        && second < config.session_close_utc_s as i64;
    // A zero in `closed_days` is an empty slot, not Jan 1, 1970.
    let closed_day = day > 0 && config.closed_days.iter().any(|d| *d as i64 == day);
    in_session && !closed_day && now >= config.closed_until
}

/// Check 9. An asset that trades at all hours (`session` 0) is always open.
pub fn check_market(session: u8, config: &Config, now: i64) -> Result<()> {
    require!(
        session == 0 || market_open(config, now),
        BasketError::MarketClosed
    );
    Ok(())
}

/// Check 6. One keeper trade per asset per cooldown.
pub fn check_cooldown(last_keeper_ts: i64, cooldown_s: u32, now: i64) -> Result<()> {
    require!(
        now >= last_keeper_ts.saturating_add(cooldown_s as i64),
        BasketError::Cooldown
    );
    Ok(())
}

/// `share × whole` against `part × 10,000`, without dividing. None when a product does not fit.
fn against(part: u128, whole: u128, share_bps: u32) -> Option<(u128, u128)> {
    part.checked_mul(BPS as u128)
        .zip(whole.checked_mul(share_bps as u128))
}

/// Check 5, before the trade. A weight is the asset's value over everything the vault
/// holds, cash included. A purchase needs the asset under its target and a sale needs it
/// over: anything else moves away from the target.
pub fn check_toward_target(
    buying: bool,
    asset_value: u128,
    vault_value: u128,
    target_bps: u16,
) -> Result<()> {
    let Some((weight, target)) = against(asset_value, vault_value, target_bps as u32) else {
        return err!(BasketError::AssetNotPriced);
    };
    require!(
        if buying {
            weight < target
        } else {
            weight > target
        },
        BasketError::NotTowardTarget
    );
    Ok(())
}

/// Check 5, after the trade. The asset may sit anywhere inside the band, on either side of
/// its target; outside the band on the far side is past it.
pub fn check_inside_band(
    buying: bool,
    asset_value: u128,
    vault_value: u128,
    target_bps: u16,
    band_bps: u16,
) -> Result<()> {
    let edge = if buying {
        target_bps as u32 + band_bps as u32
    } else {
        (target_bps as u32).saturating_sub(band_bps as u32)
    };
    let Some((weight, limit)) = against(asset_value, vault_value, edge) else {
        return err!(BasketError::AssetNotPriced);
    };
    require!(
        if buying {
            weight <= limit
        } else {
            weight >= limit
        },
        BasketError::PastTarget
    );
    Ok(())
}

/// Check 4. What came in is worth at least what went out, less the tolerance, both at the
/// reference price. This is the minimum output the program works out for itself.
pub fn check_value(spent_value: u128, received_value: u128, tolerance_bps: u16) -> Result<()> {
    let enough = received_value
        .checked_mul(BPS as u128)
        .zip(spent_value.checked_mul((BPS as u128).saturating_sub(tolerance_bps as u128)))
        .is_some_and(|(received, floor)| received >= floor);
    require!(enough, BasketError::ReceivedTooLittle);
    Ok(())
}

/// Check 7. What is left of the loss counter `now`: it falls in a straight line to nothing
/// over seven days from when it was last written.
pub fn decayed_loss(loss_accum: u64, loss_ts: i64, now: i64) -> u64 {
    let elapsed = now.saturating_sub(loss_ts).clamp(0, LOSS_WINDOW_S);
    let left = (loss_accum as u128) * ((LOSS_WINDOW_S - elapsed) as u128) / (LOSS_WINDOW_S as u128);
    left as u64
}

/// Check 7. The counter, with this leg's loss added, stays within `loss_cap_bps` of what
/// the vault was worth before the leg.
pub fn check_loss_cap(loss_used: u128, vault_value: u128, loss_cap_bps: u16) -> Result<()> {
    let within = against(loss_used, vault_value, loss_cap_bps as u32)
        .is_some_and(|(used, cap)| used <= cap);
    require!(within, BasketError::LossCapReached);
    Ok(())
}
