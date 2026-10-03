use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::checks::mint_has_hook_program;
use crate::errors::BasketError;
use crate::events::AssetSet;
use crate::state::{
    AssetEntry, AssetRegistry, Config, ASSETS_SEED, BPS, CONFIG_SEED, MAX_ASSETS,
    MAX_PRICE_ACCOUNTS,
};

/// A price account in Scope's layout holds 512 entries.
pub const PRICE_ENTRIES: u16 = 512;

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
        require!(args.flags == 0, BasketError::ParamOutOfBounds);

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
            reserved: [0; 21],
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
