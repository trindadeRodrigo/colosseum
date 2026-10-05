use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::checks::mint_has_hook_program;
use crate::errors::BasketError;
use crate::events::{AssetSet, PriceAccountSet};
use crate::price::{PRICES_LEN, PRICE_ENTRIES};
use crate::state::{
    AssetEntry, AssetRegistry, Config, ASSETS_SEED, ASSET_KEEPER, BPS, CONFIG_SEED, MAX_ASSETS,
    MAX_PRICE_ACCOUNTS, MAX_PRICE_RANGE_RATIO,
};

/// Admin, once: creates the empty asset list.
#[derive(Accounts)]
pub struct InitAssets<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = admin,
        space = AssetRegistry::SPACE,
        seeds = [ASSETS_SEED],
        bump
    )]
    pub assets: AccountLoader<'info, AssetRegistry>,
    pub system_program: Program<'info, System>,
}

impl InitAssets<'_> {
    pub fn handle(ctx: Context<InitAssets>) -> Result<()> {
        // Every byte starts at zero: no price account, no entry.
        ctx.accounts.assets.load_init()?;
        Ok(())
    }
}

/// What the admin chooses for one token. Its decimals are read from the mint.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct AssetArgs {
    pub price_slot: u8,
    pub price_index: u16,
    pub twap_index: u16,
    pub price_kind: u8,
    pub session: u8,
    pub max_weight_bps: u16,
    pub flags: u8,
    pub source_check: [u8; 32],
    /// The plausible price range, in millionths of a dollar for one whole token.
    pub min_price: u64,
    pub max_price: u64,
}

/// Admin: lists a token, or rewrites the entry of one that is listed.
#[derive(Accounts)]
pub struct UpsertAsset<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [ASSETS_SEED],
        bump
    )]
    pub assets: AccountLoader<'info, AssetRegistry>,
    /// A mint of either token program.
    pub mint: InterfaceAccount<'info, Mint>,
}

impl UpsertAsset<'_> {
    pub fn handle(ctx: Context<UpsertAsset>, args: AssetArgs) -> Result<()> {
        require!(
            (args.price_slot as usize) < MAX_PRICE_ACCOUNTS,
            BasketError::ParamOutOfBounds
        );
        require!(args.price_kind <= 1, BasketError::ParamOutOfBounds);
        require!(
            args.price_index < PRICE_ENTRIES,
            BasketError::ParamOutOfBounds
        );
        require!(
            args.twap_index < PRICE_ENTRIES,
            BasketError::ParamOutOfBounds
        );
        require!(args.session <= 1, BasketError::ParamOutOfBounds);
        require!(
            args.max_weight_bps as u32 <= BPS,
            BasketError::ParamOutOfBounds
        );
        require!(
            args.flags & !ASSET_KEEPER == 0,
            BasketError::ParamOutOfBounds
        );
        // The keeper's switch is for an asset with a price entry and an average of its own:
        // an average at the price's own index would compare the price with itself.
        require!(
            args.flags & ASSET_KEEPER == 0
                || (args.price_kind == 1 && args.twap_index != args.price_index),
            BasketError::AssetNotPriced
        );
        // A price range is a floor, a ceiling above it, and no wider than the ceiling being
        // twice the floor. Zero and zero is no range.
        if args.min_price != 0 || args.max_price != 0 {
            require!(
                args.min_price < args.max_price,
                BasketError::ParamOutOfBounds
            );
            require!(
                args.max_price <= args.min_price.saturating_mul(MAX_PRICE_RANGE_RATIO),
                BasketError::ParamOutOfBounds
            );
        }
        // And the switch is for an asset that has one: no range is never "any price".
        require!(
            args.flags & ASSET_KEEPER == 0 || args.max_price != 0,
            BasketError::AssetNotPriced
        );

        let mint = &ctx.accounts.mint;
        require!(
            !has_hook_program(&mint.to_account_info())?,
            BasketError::HookNotAllowed
        );

        let mut registry = ctx.accounts.assets.load_mut()?;
        let count = (registry.count as usize).min(MAX_ASSETS);
        let key = mint.key();
        let index = match registry.assets[..count].iter().position(|e| e.mint == key) {
            Some(index) => index,
            None => {
                require!(count < MAX_ASSETS, BasketError::AssetListFull);
                registry.count = count as u8 + 1;
                count
            }
        };
        registry.assets[index] = AssetEntry {
            mint: key,
            price_slot: args.price_slot,
            price_index: args.price_index,
            twap_index: args.twap_index,
            decimals: mint.decimals,
            price_kind: args.price_kind,
            session: args.session,
            max_weight_bps: args.max_weight_bps,
            flags: args.flags,
            source_check: args.source_check,
            min_price: args.min_price,
            max_price: args.max_price,
            reserved: [0; 5],
        };
        emit!(AssetSet {
            mint: key,
            index: index as u8,
            max_weight_bps: args.max_weight_bps,
        });
        Ok(())
    }
}

/// True when the mint names a transfer hook program. A hook runs inside every transfer of
/// the token, with whatever accounts it asks for, so a token that has one is not listed.
/// The stock tokens carry the extension with no program set: that is not a hook. Only a
/// Token-2022 mint can have one.
fn has_hook_program(mint: &AccountInfo) -> Result<bool> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(false);
    }
    mint_has_hook_program(&mint.try_borrow_data()?)
}

/// Admin, until `launch()`: names the price account of one slot of the asset list. An
/// entry's `price_slot` points at one of the four. The account comes in as an account and
/// has to be one the price program owns, in the layout the keeper leg reads: an address
/// that is not, locked in by `launch()`, would mean no keeper trade until an upgrade.
#[derive(Accounts)]
pub struct SetPriceAccount<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [ASSETS_SEED],
        bump
    )]
    pub assets: AccountLoader<'info, AssetRegistry>,
    /// CHECK: any account the price program owns, of the size of a price account.
    #[account(
        owner = config.price_owner @ BasketError::AssetNotPriced,
        constraint = price_account.data_len() == PRICES_LEN @ BasketError::AssetNotPriced
    )]
    pub price_account: UncheckedAccount<'info>,
}

impl SetPriceAccount<'_> {
    pub fn handle(ctx: Context<SetPriceAccount>, slot: u8) -> Result<()> {
        // The price account is one of the things a vault trusts, like the price program.
        require!(!ctx.accounts.config.launched, BasketError::LockedAtLaunch);
        require!(
            (slot as usize) < MAX_PRICE_ACCOUNTS,
            BasketError::ParamOutOfBounds
        );
        let new = ctx.accounts.price_account.key();
        let mut registry = ctx.accounts.assets.load_mut()?;
        emit!(PriceAccountSet {
            slot,
            old: registry.price_accounts[slot as usize],
            new,
        });
        registry.price_accounts[slot as usize] = new;
        Ok(())
    }
}
