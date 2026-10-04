//! The price reference a keeper leg is measured against, read by hand from an account in
//! Kamino Scope's layout (its crate is BUSL-licensed).
//!
//! The account is 28,712 bytes: a 40-byte header, then 512 entries of 56 bytes. Entry `i`
//! starts at `40 + 56·i`: value u64, exponent u64, slot u64, unix time u64, then 24 bytes
//! of the source's own. The price is `value / 10^exponent`, in dollars for one whole token.
//! An asset has two entries: its price, and the same source's one-hour average.
//!
//! A keeper trade is valued at this reference, so a wrong reference is not bounded by the
//! tolerance or by the loss cap. Four things stand between a bad entry and a trade: the
//! admin's switch on the asset, the price range the admin gave it, the age of both entries,
//! and the distance between them.

use anchor_lang::prelude::*;

use crate::errors::BasketError;
use crate::state::{AssetEntry, AssetRegistry, Config, Vault, BPS, MAX_POSITIONS};

pub const PRICES_HEADER_LEN: usize = 40;
pub const PRICE_ENTRY_LEN: usize = 56;
/// A price account in Scope's layout holds 512 entries.
pub const PRICE_ENTRIES: u16 = 512;
pub const PRICES_LEN: usize = PRICES_HEADER_LEN + PRICE_ENTRY_LEN * PRICE_ENTRIES as usize;
/// A larger exponent is not a price this program can compare without overflow.
pub const MAX_PRICE_EXPONENT: u64 = 18;
/// The one-hour average may be an hour old: it is still an average of the last two hours.
pub const MAX_TWAP_AGE_S: i64 = 3_600;
/// An asset's price range is in millionths of a dollar.
pub const RANGE_UNIT: u128 = 1_000_000;
/// The most a vault may be worth for the keeper to trade it, in raw units of the cash mint:
/// 10^17, which is a hundred billion dollars of a six-decimal dollar. Every value the
/// keeper's checks multiply is a part of a vault's value, so under this bound every product
/// they form fits 128 bits; the largest is a distance from a target times a vault's value,
/// 10^4 · 10^17 · 10^17. Past it nothing is computed and the leg is refused.
pub const MAX_VAULT_VALUE: u128 = 100_000_000_000_000_000;

/// One entry of a price account.
pub struct PriceEntry {
    pub value: u64,
    pub exponent: u32,
    pub unix_timestamp: i64,
}

/// A price the checks have passed: dollars for one whole token, as `value / 10^exponent`.
#[derive(Clone, Copy)]
pub struct Reference {
    pub value: u64,
    pub exponent: u32,
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[at..at + 8]);
    u64::from_le_bytes(bytes)
}

/// Entry `index` of a price account's data, for an index the asset list holds: under 512.
/// An account that is not the size of a price account, an entry nobody wrote, or one that
/// cannot be a price (no value, no time, an absurd exponent) is `AssetNotPriced`.
pub fn read_entry(data: &[u8], index: u16) -> Result<PriceEntry> {
    require!(data.len() == PRICES_LEN, BasketError::AssetNotPriced);
    let at = PRICES_HEADER_LEN + PRICE_ENTRY_LEN * index as usize;
    let value = u64_at(data, at);
    let exponent = u64_at(data, at + 8);
    let unix_timestamp = u64_at(data, at + 24);
    require!(value > 0, BasketError::AssetNotPriced);
    require!(unix_timestamp > 0, BasketError::AssetNotPriced);
    require!(
        unix_timestamp <= i64::MAX as u64,
        BasketError::AssetNotPriced
    );
    require!(exponent <= MAX_PRICE_EXPONENT, BasketError::AssetNotPriced);
    Ok(PriceEntry {
        value,
        exponent: exponent as u32,
        unix_timestamp: unix_timestamp as i64,
    })
}

/// An entry is fresh when it was written at most `max_age_s` ago. One stamped further ahead
/// of the clock than that was not stamped in unix seconds, and is refused too.
pub fn check_fresh(unix_timestamp: i64, now: i64, max_age_s: i64) -> Result<()> {
    let age = now.saturating_sub(unix_timestamp);
    require!(age <= max_age_s, BasketError::PriceStale);
    require!(age >= -max_age_s, BasketError::PriceStale);
    Ok(())
}

/// The price is inside the range the admin gave the asset: no lower than `min_price` and no
/// higher than `max_price`, both in millionths of a dollar for one whole token. An asset
/// with no range (zero and zero) has no price that passes. Nothing here overflows: an entry's
/// value is under 2^64 and its exponent at most 18.
pub fn check_range(price: &PriceEntry, min_price: u64, max_price: u64) -> Result<()> {
    let scaled = (price.value as u128) * RANGE_UNIT;
    let unit = 10u128.pow(price.exponent);
    require!(
        scaled >= (min_price as u128) * unit,
        BasketError::PriceOutOfRange
    );
    require!(
        scaled <= (max_price as u128) * unit,
        BasketError::PriceOutOfRange
    );
    Ok(())
}

/// The price is within `dev_bps` of its average, above or below. Both are brought to the
/// same exponent first, so nothing is divided. That step cannot overflow: a value is under
/// 2^64 and the exponents differ by at most 18. The comparison after it can, for two entries
/// that are a factor of 10^15 apart or more: that is refused as too far, which it is.
pub fn check_deviation(price: &PriceEntry, twap: &PriceEntry, dev_bps: u16) -> Result<()> {
    let exponent = price.exponent.max(twap.exponent);
    let scaled = |entry: &PriceEntry| (entry.value as u128) * 10u128.pow(exponent - entry.exponent);
    let (spot, average) = (scaled(price), scaled(twap));
    let within = spot
        .abs_diff(average)
        .checked_mul(BPS as u128)
        .zip(average.checked_mul(dev_bps as u128))
        .is_some_and(|(distance, allowed)| distance <= allowed);
    require!(within, BasketError::PriceDeviation);
    Ok(())
}

/// The price a keeper leg may value this asset at, or the reason it may not.
///
/// The asset has a price entry and the admin has switched it on for the keeper; the entry
/// asks for no check of its source this program cannot make; the price account that was
/// passed is the one the asset list names for the asset's slot; the price is inside the
/// asset's range; it is fresh; its one-hour average is no older than an hour; and the two
/// are within `twap_dev_bps` of each other.
pub fn reference(
    prices: &[u8],
    prices_key: &Pubkey,
    registry: &AssetRegistry,
    entry: &AssetEntry,
    config: &Config,
    now: i64,
) -> Result<Reference> {
    require!(entry.price_kind == 1, BasketError::AssetNotPriced);
    require!(entry.keeper_on(), BasketError::KeeperAssetOff);
    // `source_check` asks that the entry's source be compared with a pinned one. That
    // comparison is not built: an asset that asks for it is not traded.
    let source_check = entry.source_check;
    require!(source_check == [0u8; 32], BasketError::AssetNotPriced);
    let pinned = registry
        .price_accounts
        .get(entry.price_slot as usize)
        .copied()
        .unwrap_or_default();
    require!(pinned == *prices_key, BasketError::AssetNotPriced);

    let price = read_entry(prices, entry.price_index)?;
    check_range(&price, entry.min_price, entry.max_price)?;
    check_fresh(price.unix_timestamp, now, config.max_price_age_s as i64)?;
    let twap = read_entry(prices, entry.twap_index)?;
    check_fresh(twap.unix_timestamp, now, MAX_TWAP_AGE_S)?;
    check_deviation(&price, &twap, config.twap_dev_bps)?;
    Ok(Reference {
        value: price.value,
        exponent: price.exponent,
    })
}

/// What `amount` raw units of an asset are worth at `price`, in raw units of the cash
/// mint, with cash counted as one dollar. Rounded down. A value too large for 128 bits
/// comes out as the largest there is, which is past what any vault may be worth
/// (`vault_value`); the product of the amount and the price's value always fits.
pub fn value_in_cash(
    amount: u64,
    price: &Reference,
    asset_decimals: u8,
    cash_decimals: u8,
) -> u128 {
    let product = (amount as u128) * (price.value as u128);
    let down = price.exponent + asset_decimals as u32;
    let up = cash_decimals as u32;
    if up >= down {
        product.saturating_mul(10u128.saturating_pow(up - down))
    } else {
        product / 10u128.saturating_pow(down - up)
    }
}

/// What a vault is worth: its cash at one dollar, the asset the leg trades, and its other
/// positions. A vault past `MAX_VAULT_VALUE` is refused before anything is multiplied.
pub fn vault_value(others: u128, asset: u128, cash: u64) -> Result<u128> {
    let total = others.saturating_add(asset).saturating_add(cash as u128);
    require!(total <= MAX_VAULT_VALUE, BasketError::AssetNotPriced);
    Ok(total)
}

/// The value of every position but `except`, by what the program last recorded for each
/// (`tracked`), in raw units of the cash mint. Every position the vault holds something of
/// has to pass `reference`: one asset that cannot be valued stops the leg, since the
/// weights and the loss cap are shares of the whole.
#[allow(clippy::too_many_arguments)]
pub fn value_of_others(
    vault: &Vault,
    except: &Pubkey,
    prices: &[u8],
    prices_key: &Pubkey,
    registry: &AssetRegistry,
    config: &Config,
    cash_decimals: u8,
    now: i64,
) -> Result<u128> {
    let count = (vault.count as usize).min(MAX_POSITIONS);
    let mut total: u128 = 0;
    for position in vault.positions[..count].iter() {
        if position.mint == *except || position.tracked == 0 {
            continue;
        }
        let entry = registry
            .find(&position.mint)
            .ok_or(BasketError::AssetNotPriced)?;
        let price = reference(prices, prices_key, registry, entry, config, now)?;
        let value = value_in_cash(position.tracked, &price, entry.decimals, cash_decimals);
        total = total.saturating_add(value);
    }
    Ok(total)
}
