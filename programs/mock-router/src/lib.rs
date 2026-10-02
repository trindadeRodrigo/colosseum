//! Test exchange. Not part of the product and never meant for mainnet.
//!
//! It stands in for Jupiter in LiteSVM tests and on devnet, where Jupiter does not exist.
//! It takes the input token from the trader's token account and pays the output token
//! from its own reserve, at a price its admin sets per pair. TNET-4 finishes it (the price
//! read from a test price account, a spread, who may initialise it on devnet).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("2ticePjZZ6e34bNUgUXz7v3uHm3jS8jvV13gesdvKn4f");

pub const ROUTER_SEED: &[u8] = b"router";
pub const PAIR_SEED: &[u8] = b"pair";

#[program]
pub mod mock_router {
    use super::*;

    /// Creates the one router account. Its address also owns the reserve token accounts.
    pub fn init_router(ctx: Context<InitRouter>) -> Result<()> {
        let router = &mut ctx.accounts.router;
        router.admin = ctx.accounts.admin.key();
        router.bump = ctx.bumps.router;
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
        Ok(())
    }

    pub fn set_price(ctx: Context<SetPrice>, price_num: u64, price_den: u64) -> Result<()> {
        require!(price_den > 0, MockRouterError::ZeroDenominator);
        let pair = &mut ctx.accounts.pair;
        pair.price_num = price_num;
        pair.price_den = price_den;
        Ok(())
    }

    /// Named after Jupiter's `route_v2` so the first eight bytes of the instruction data
    /// are the same, and a vault's selector check needs no test-only branch.
    /// The arguments after those eight bytes are this program's own.
    pub fn route_v2(ctx: Context<RouteV2>, amount_in: u64, min_out: u64) -> Result<()> {
        let pair = &ctx.accounts.pair;
        let out = (amount_in as u128)
            .checked_mul(pair.price_num as u128)
            .and_then(|v| v.checked_div(pair.price_den as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(MockRouterError::Overflow)?;
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

#[account]
#[derive(InitSpace)]
pub struct Router {
    pub admin: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pair {
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub price_num: u64,
    pub price_den: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitRouter<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Router::INIT_SPACE, seeds = [ROUTER_SEED], bump)]
    pub router: Account<'info, Router>,
    pub system_program: Program<'info, System>,
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
}
