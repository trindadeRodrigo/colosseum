//! Test exchange and test price source. Not part of the product and never meant for mainnet.
//!
//! It stands in for Jupiter in LiteSVM tests and on devnet, where Jupiter does not exist.
//! It takes the input token from the trader's token account and pays the output token
//! from its own reserve. A pair pays either a fixed ratio its admin sets, or the price in
//! the program's own price account less a spread.
//!
//! The price account stands in for Kamino Scope's, which devnet does not have either. It
//! has Scope's layout to the byte: 28,712 bytes, a 40-byte header, then 512 entries of 56
//! bytes, entry `i` at `40 + 56·i`: value u64, exponent u64, slot u64, unix time u64. The
//! vault program reads it as it reads Scope's, with this program as `Config.price_owner`.
//! The admin writes it, and so does one more key the admin names: the job that copies real
//! prices onto the test network.
//!
//! Only the program's upgrade authority can initialise the exchange, and becomes its admin.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::program::MockRouter;

declare_id!("2ticePjZZ6e34bNUgUXz7v3uHm3jS8jvV13gesdvKn4f");

pub const ROUTER_SEED: &[u8] = b"router";
pub const PAIR_SEED: &[u8] = b"pair";

pub const PRICES_HEADER_LEN: usize = 40;
pub const PRICE_ENTRY_LEN: usize = 56;
pub const PRICE_ENTRIES: u16 = 512;
/// 28,712 bytes: what a Scope price account is.
pub const PRICES_LEN: usize = PRICES_HEADER_LEN + PRICE_ENTRY_LEN * PRICE_ENTRIES as usize;
/// sha256("account:OraclePrices")[0..8]: what Scope's own price account starts with.
pub const SCOPE_PRICES_DISCRIMINATOR: [u8; 8] = [89, 128, 118, 221, 6, 72, 180, 146];
pub const BPS: u64 = 10_000;
/// A spread is a cost that looks real, not a way to empty a vault: 10% at most.
pub const MAX_SPREAD_BPS: u16 = 1_000;

/// A pair that pays `price_num / price_den`.
pub const PAIR_FIXED: u8 = 0;
/// A pair that pays the price account's entry for its asset, less the spread.
pub const PAIR_PRICED: u8 = 1;

#[program]
pub mod mock_router {
    use super::*;

    /// Creates the one router account. Its address also owns the reserve token accounts.
    /// The signer must be the program's upgrade authority and becomes the admin, who sets
    /// the prices: whoever got there first could otherwise name any price on a network
    /// where people try the product.
    pub fn init_router(ctx: Context<InitRouter>) -> Result<()> {
        let router = &mut ctx.accounts.router;
        router.admin = ctx.accounts.admin.key();
        router.bump = ctx.bumps.router;
        router.prices = Pubkey::default();
        router.price_writer = Pubkey::default();
        Ok(())
    }

    /// Admin, once. Takes a fresh account as the exchange's price account. The account was
    /// made by the system program for this program, at the size of a Scope price account,
    /// and holds nothing yet: an account that large cannot be made from inside a program.
    pub fn init_prices(ctx: Context<InitPrices>) -> Result<()> {
        let router = &mut ctx.accounts.router;
        require!(
            router.prices == Pubkey::default(),
            MockRouterError::PricesAlreadySet
        );
        let mut data = ctx.accounts.prices.try_borrow_mut_data()?;
        require!(
            data[..PRICES_HEADER_LEN].iter().all(|byte| *byte == 0),
            MockRouterError::NotPriceAccount
        );
        // Scope's header: its discriminator, then the address of its mappings account.
        // Nothing here has mappings: the exchange's own address goes in their place.
        data[..8].copy_from_slice(&SCOPE_PRICES_DISCRIMINATOR);
        data[8..PRICES_HEADER_LEN].copy_from_slice(router.key().as_ref());
        router.prices = ctx.accounts.prices.key();
        Ok(())
    }

    /// Admin. Names the one other key that may write prices, or none (all zeros).
    pub fn set_price_writer(ctx: Context<SetRouter>, price_writer: Pubkey) -> Result<()> {
        ctx.accounts.router.price_writer = price_writer;
        Ok(())
    }

    /// The admin or the price writer. Writes one asset's two entries: its price and its
    /// one-hour average, each with its value, its exponent and the unix time it was true
    /// at. The slot written is this cluster's. Nothing is checked about the values: a test
    /// network has to be able to show a price that is stale, missing or wrong.
    pub fn write_price(ctx: Context<WritePrice>, args: PriceArgs) -> Result<()> {
        let router = &ctx.accounts.router;
        let writer = ctx.accounts.writer.key();
        require!(
            writer == router.admin
                || (router.price_writer != Pubkey::default() && writer == router.price_writer),
            MockRouterError::NotPriceWriter
        );
        require!(
            args.price_index < PRICE_ENTRIES
                && args.twap_index < PRICE_ENTRIES
                && args.price_index != args.twap_index,
            MockRouterError::BadPriceIndex
        );
        let slot = Clock::get()?.slot;
        let mut data = ctx.accounts.prices.try_borrow_mut_data()?;
        write_entry(&mut data, args.price_index, &args.price, slot);
        write_entry(&mut data, args.twap_index, &args.twap, slot);
        Ok(())
    }

    /// Lists a pair in one direction: `amount_in * price_num / price_den` raw units come out.
    pub fn init_pair(ctx: Context<InitPair>, price_num: u64, price_den: u64) -> Result<()> {
        require!(price_den > 0, MockRouterError::ZeroDenominator);
        let pair = &mut ctx.accounts.pair;
        pair.mint_in = ctx.accounts.mint_in.key();
        pair.mint_out = ctx.accounts.mint_out.key();
        pair.price_num = price_num;
        pair.price_den = price_den;
        pair.bump = ctx.bumps.pair;
        pair.kind = PAIR_FIXED;
        Ok(())
    }

    /// Sets a pair's fixed ratio. A pair that paid the price account's price pays this now.
    pub fn set_price(ctx: Context<SetPrice>, price_num: u64, price_den: u64) -> Result<()> {
        require!(price_den > 0, MockRouterError::ZeroDenominator);
        let pair = &mut ctx.accounts.pair;
        pair.price_num = price_num;
        pair.price_den = price_den;
        pair.kind = PAIR_FIXED;
        Ok(())
    }

    /// Lists a pair in one direction that pays the price account's price: one side is the
    /// asset whose entry is `price_index`, the other the dollar token at one dollar.
    /// `asset_is_input` says which side the asset is on. The trader gets the price less
    /// `spread_bps`, which stays in the reserve.
    pub fn init_priced_pair(
        ctx: Context<InitPair>,
        asset_is_input: bool,
        price_index: u16,
        spread_bps: u16,
    ) -> Result<()> {
        check_priced(price_index, spread_bps)?;
        let pair = &mut ctx.accounts.pair;
        pair.mint_in = ctx.accounts.mint_in.key();
        pair.mint_out = ctx.accounts.mint_out.key();
        pair.price_num = 0;
        pair.price_den = 1;
        pair.bump = ctx.bumps.pair;
        pair.kind = PAIR_PRICED;
        pair.asset_is_input = asset_is_input;
        pair.price_index = price_index;
        pair.spread_bps = spread_bps;
        Ok(())
    }

    /// Makes a listed pair pay the price account's price, or changes its entry or spread.
    pub fn set_priced_pair(
        ctx: Context<SetPrice>,
        asset_is_input: bool,
        price_index: u16,
        spread_bps: u16,
    ) -> Result<()> {
        check_priced(price_index, spread_bps)?;
        let pair = &mut ctx.accounts.pair;
        pair.kind = PAIR_PRICED;
        pair.asset_is_input = asset_is_input;
        pair.price_index = price_index;
        pair.spread_bps = spread_bps;
        Ok(())
    }

    /// Named after Jupiter's `route_v2` so the first eight bytes of the instruction data
    /// are the same, and a vault's selector check needs no test-only branch.
    /// The arguments after those eight bytes are this program's own.
    ///
    /// A pair that pays the price account's price takes that account as the one account
    /// after the token programs.
    pub fn route_v2(ctx: Context<RouteV2>, amount_in: u64, min_out: u64) -> Result<()> {
        let pair = &ctx.accounts.pair;
        let out = if pair.kind == PAIR_PRICED {
            let prices = ctx
                .remaining_accounts
                .first()
                .ok_or(MockRouterError::NotPriceAccount)?;
            require!(
                *prices.key == ctx.accounts.router.prices,
                MockRouterError::NotPriceAccount
            );
            let data = prices.try_borrow_data()?;
            let (value, exponent) = read_entry(&data, pair.price_index);
            require!(value > 0, MockRouterError::NoPrice);
            let (asset, cash) = if pair.asset_is_input {
                (&ctx.accounts.mint_in, &ctx.accounts.mint_out)
            } else {
                (&ctx.accounts.mint_out, &ctx.accounts.mint_in)
            };
            priced_out(
                amount_in,
                value,
                exponent,
                asset.decimals,
                cash.decimals,
                pair.asset_is_input,
                pair.spread_bps,
            )
            .ok_or(MockRouterError::Overflow)?
        } else {
            (amount_in as u128)
                .checked_mul(pair.price_num as u128)
                .and_then(|v| v.checked_div(pair.price_den as u128))
                .and_then(|v| u64::try_from(v).ok())
                .ok_or(MockRouterError::Overflow)?
        };
        require!(out >= min_out, MockRouterError::BelowMinOut);

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_in.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.trader_in.to_account_info(),
                    mint: ctx.accounts.mint_in.to_account_info(),
                    to: ctx.accounts.reserve_in.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            amount_in,
            ctx.accounts.mint_in.decimals,
        )?;

        let bump = [ctx.accounts.router.bump];
        let seeds: &[&[u8]] = &[ROUTER_SEED, &bump];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_out.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.reserve_out.to_account_info(),
                    mint: ctx.accounts.mint_out.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.router.to_account_info(),
                },
                &[seeds],
            ),
            out,
            ctx.accounts.mint_out.decimals,
        )?;

        msg!("mock route: in={} out={}", amount_in, out);
        Ok(())
    }
}

/// One entry as the price account holds it: `value / 10^exponent` dollars for one whole
/// token, true at `unix_timestamp`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PriceEntry {
    pub value: u64,
    pub exponent: u64,
    pub unix_timestamp: u64,
}

/// One asset's price and its one-hour average, and where each sits in the price account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PriceArgs {
    pub price_index: u16,
    pub twap_index: u16,
    pub price: PriceEntry,
    pub twap: PriceEntry,
}

fn check_priced(price_index: u16, spread_bps: u16) -> Result<()> {
    require!(price_index < PRICE_ENTRIES, MockRouterError::BadPriceIndex);
    require!(spread_bps <= MAX_SPREAD_BPS, MockRouterError::SpreadTooWide);
    Ok(())
}

/// Entry `index` starts at `40 + 56·index`: value, exponent, slot, unix time, each a u64.
/// The 24 bytes after them are the source's own on Scope, and stay zero here.
fn write_entry(data: &mut [u8], index: u16, entry: &PriceEntry, slot: u64) {
    let at = PRICES_HEADER_LEN + PRICE_ENTRY_LEN * index as usize;
    data[at..at + 8].copy_from_slice(&entry.value.to_le_bytes());
    data[at + 8..at + 16].copy_from_slice(&entry.exponent.to_le_bytes());
    data[at + 16..at + 24].copy_from_slice(&slot.to_le_bytes());
    data[at + 24..at + 32].copy_from_slice(&entry.unix_timestamp.to_le_bytes());
}

/// The value and the exponent of entry `index`. An exponent too large for a u32 reads as
/// the largest, which no arithmetic below survives: the route fails.
fn read_entry(data: &[u8], index: u16) -> (u64, u32) {
    let at = PRICES_HEADER_LEN + PRICE_ENTRY_LEN * index as usize;
    let word = |from: usize| {
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&data[from..from + 8]);
        u64::from_le_bytes(bytes)
    };
    (word(at), u32::try_from(word(at + 8)).unwrap_or(u32::MAX))
}

/// What a priced pair pays for `amount_in`, in raw units of the output: the price, with
/// the dollar token at one dollar, less the spread, rounded down. None when it does not fit.
fn priced_out(
    amount_in: u64,
    value: u64,
    exponent: u32,
    asset_decimals: u8,
    cash_decimals: u8,
    asset_is_input: bool,
    spread_bps: u16,
) -> Option<u64> {
    // One raw unit of the asset is `value / 10^down` dollars, and a dollar is `10^up` raw
    // units of the dollar token.
    let down = exponent.checked_add(asset_decimals as u32)?;
    let up = cash_decimals as u32;
    let amount = amount_in as u128;
    let gross = if asset_is_input {
        let product = amount.checked_mul(value as u128)?;
        if up >= down {
            product.checked_mul(10u128.checked_pow(up - down)?)?
        } else {
            product / 10u128.checked_pow(down - up)?
        }
    } else if down >= up {
        amount.checked_mul(10u128.checked_pow(down - up)?)? / value as u128
    } else {
        amount / (value as u128).checked_mul(10u128.checked_pow(up - down)?)?
    };
    let net = gross.checked_mul(BPS.checked_sub(spread_bps as u64)? as u128)? / BPS as u128;
    u64::try_from(net).ok()
}

#[account]
#[derive(InitSpace)]
pub struct Router {
    pub admin: Pubkey,
    pub bump: u8,
    /// The exchange's price account, once `init_prices` has taken one; all zeros before.
    pub prices: Pubkey,
    /// The one other key that may write prices; all zeros when there is none.
    pub price_writer: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Pair {
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub price_num: u64,
    pub price_den: u64,
    pub bump: u8,
    /// `PAIR_FIXED` or `PAIR_PRICED`.
    pub kind: u8,
    /// For a priced pair: true when the input is the asset and the output the dollar token.
    pub asset_is_input: bool,
    /// For a priced pair: the asset's price entry in the price account.
    pub price_index: u16,
    /// For a priced pair: what the exchange keeps of every trade.
    pub spread_bps: u16,
}

#[derive(Accounts)]
pub struct InitRouter<'info> {
    /// The program's upgrade authority. It becomes the admin.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Router::INIT_SPACE, seeds = [ROUTER_SEED], bump)]
    pub router: Account<'info, Router>,
    /// This program, to find its program data account.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ MockRouterError::NotUpgradeAuthority
    )]
    pub program: Program<'info, MockRouter>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ MockRouterError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitPrices<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUTER_SEED], bump = router.bump, has_one = admin)]
    pub router: Account<'info, Router>,
    /// CHECK: an account this program owns, the size of a Scope price account. That it
    /// was never written is checked in the handler.
    #[account(
        mut,
        owner = crate::ID @ MockRouterError::NotPriceAccount,
        constraint = prices.data_len() == PRICES_LEN @ MockRouterError::NotPriceAccount
    )]
    pub prices: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetRouter<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ROUTER_SEED], bump = router.bump, has_one = admin)]
    pub router: Account<'info, Router>,
}

#[derive(Accounts)]
pub struct WritePrice<'info> {
    /// The admin, or the price writer the admin named.
    pub writer: Signer<'info>,
    #[account(
        seeds = [ROUTER_SEED],
        bump = router.bump,
        has_one = prices @ MockRouterError::NotPriceAccount
    )]
    pub router: Account<'info, Router>,
    /// CHECK: the exchange's own price account, by the address the router holds. It took
    /// that address in `init_prices`, which checked its owner and its size.
    #[account(mut)]
    pub prices: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitPair<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [ROUTER_SEED], bump = router.bump, has_one = admin)]
    pub router: Account<'info, Router>,
    pub mint_in: InterfaceAccount<'info, Mint>,
    pub mint_out: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + Pair::INIT_SPACE,
        seeds = [PAIR_SEED, mint_in.key().as_ref(), mint_out.key().as_ref()],
        bump
    )]
    pub pair: Account<'info, Pair>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [ROUTER_SEED], bump = router.bump, has_one = admin)]
    pub router: Account<'info, Router>,
    #[account(
        mut,
        seeds = [PAIR_SEED, pair.mint_in.as_ref(), pair.mint_out.as_ref()],
        bump = pair.bump
    )]
    pub pair: Account<'info, Pair>,
}

#[derive(Accounts)]
pub struct RouteV2<'info> {
    /// Whoever may move the input tokens: a wallet, or a vault signing by CPI.
    pub trader: Signer<'info>,
    #[account(seeds = [ROUTER_SEED], bump = router.bump)]
    pub router: Account<'info, Router>,
    #[account(
        seeds = [PAIR_SEED, mint_in.key().as_ref(), mint_out.key().as_ref()],
        bump = pair.bump
    )]
    pub pair: Account<'info, Pair>,
    pub mint_in: InterfaceAccount<'info, Mint>,
    pub mint_out: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub trader_in: InterfaceAccount<'info, TokenAccount>,
    /// Any token account of the output mint. Like a real router, the mock pays where it is
    /// told to; whether that is acceptable is the caller's check.
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_in,
        associated_token::authority = router,
        associated_token::token_program = token_program_in
    )]
    pub reserve_in: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_out,
        associated_token::authority = router,
        associated_token::token_program = token_program_out
    )]
    pub reserve_out: InterfaceAccount<'info, TokenAccount>,
    pub token_program_in: Interface<'info, TokenInterface>,
    pub token_program_out: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum MockRouterError {
    #[msg("price denominator is zero")]
    ZeroDenominator,
    #[msg("output amount does not fit")]
    Overflow,
    #[msg("output is below min_out")]
    BelowMinOut,
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("not the exchange's price account, or not an account that can become it")]
    NotPriceAccount,
    #[msg("the exchange already has a price account")]
    PricesAlreadySet,
    #[msg("signer is neither the admin nor the price writer")]
    NotPriceWriter,
    #[msg("a price index runs from 0 to 511, and an average has an entry of its own")]
    BadPriceIndex,
    #[msg("the price account holds no price at this pair's entry")]
    NoPrice,
    #[msg("a spread is at most 1,000 bps")]
    SpreadTooWide,
}
