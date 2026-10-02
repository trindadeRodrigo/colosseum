use anchor_lang::prelude::*;

use crate::checks::{check_address, check_params};
use crate::errors::BasketError;
use crate::events::{CashMintSet, PriceOwnerSet, RouterSet};
use crate::program::Basket;
use crate::state::{Config, Params, CONFIG_SEED};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct InitConfigArgs {
    pub guardian: Pubkey,
    pub default_keeper: Pubkey,
    pub router_program: Pubkey,
    pub price_owner: Pubkey,
    pub cash_mint: Pubkey,
    pub params: Params,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// The program's upgrade authority. It becomes the admin.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    /// This program, to find its program data account.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ BasketError::NotUpgradeAuthority
    )]
    pub program: Program<'info, Basket>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ BasketError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

impl InitConfig<'_> {
    pub fn handle(ctx: Context<InitConfig>, args: InitConfigArgs) -> Result<()> {
        check_params(&args.params)?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.authority.key();
        config.guardian = args.guardian;
        config.default_keeper = args.default_keeper;
        config.router_program = args.router_program;
        config.price_owner = args.price_owner;
        config.cash_mint = args.cash_mint;
        config.bump = ctx.bumps.config;
        config.tolerance_bps = args.params.tolerance_bps;
        config.loss_cap_bps = args.params.loss_cap_bps;
        config.band_bps = args.params.band_bps;
        config.twap_dev_bps = args.params.twap_dev_bps;
        config.max_price_age_s = args.params.max_price_age_s;
        config.asset_cooldown_s = args.params.asset_cooldown_s;
        config.publish_delay_s = args.params.publish_delay_s;
        config.session_open_utc_s = args.params.session_open_utc_s;
        config.session_close_utc_s = args.params.session_close_utc_s;
        Ok(())
    }
}

/// Any change to Config by the admin.
#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
}

// SOL-2: these three take effect at once. Whether they lock at `launch()` or take a delay
// is decided with the swap, which is what makes the router a power worth bounding.
impl SetConfig<'_> {
    pub fn set_router(ctx: Context<SetConfig>, router_program: Pubkey) -> Result<()> {
        check_address(&router_program)?;
        let config = &mut ctx.accounts.config;
        emit!(RouterSet {
            old: config.router_program,
            new: router_program,
        });
        config.router_program = router_program;
        Ok(())
    }

    pub fn set_price_owner(ctx: Context<SetConfig>, price_owner: Pubkey) -> Result<()> {
        check_address(&price_owner)?;
        let config = &mut ctx.accounts.config;
        emit!(PriceOwnerSet {
            old: config.price_owner,
            new: price_owner,
        });
        config.price_owner = price_owner;
        Ok(())
    }

    pub fn set_cash_mint(ctx: Context<SetConfig>, cash_mint: Pubkey) -> Result<()> {
        check_address(&cash_mint)?;
        let config = &mut ctx.accounts.config;
        emit!(CashMintSet {
            old: config.cash_mint,
            new: cash_mint,
        });
        config.cash_mint = cash_mint;
        Ok(())
    }
}
