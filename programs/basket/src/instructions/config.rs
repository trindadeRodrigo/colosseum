use anchor_lang::prelude::*;

use crate::checks::{check_address, check_params, check_router, LAUNCHED_PUBLISH_DELAY_S};
use crate::errors::BasketError;
use crate::events::{
    AdminChanged, AdminProposed, CashMintSet, KeeperPauseSet, Launched, ParamsSet, PriceOwnerSet,
    RouterSet,
};
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
        check_params(&args.params, false)?;
        check_address(&args.guardian)?;
        check_address(&args.default_keeper)?;
        check_address(&args.router_program)?;
        check_address(&args.price_owner)?;
        check_address(&args.cash_mint)?;
        check_router(&args.router_program)?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.authority.key();
        config.guardian = args.guardian;
        config.default_keeper = args.default_keeper;
        config.router_program = args.router_program;
        config.price_owner = args.price_owner;
        config.cash_mint = args.cash_mint;
        config.bump = ctx.bumps.config;
        config.apply_params(&args.params);
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

/// The router, the owner of the price accounts and the cash mint are what a vault trusts.
/// The admin may change them while only team money is in. `launch()` locks all three: after
/// it a change needs a program upgrade, which anyone can see.
fn check_not_launched(config: &Config) -> Result<()> {
    require!(!config.launched, BasketError::LockedAtLaunch);
    Ok(())
}

impl SetConfig<'_> {
    pub fn set_router(ctx: Context<SetConfig>, router_program: Pubkey) -> Result<()> {
        check_not_launched(&ctx.accounts.config)?;
        check_address(&router_program)?;
        check_router(&router_program)?;
        let config = &mut ctx.accounts.config;
        emit!(RouterSet {
            old: config.router_program,
            new: router_program,
        });
        config.router_program = router_program;
        Ok(())
    }

    pub fn set_price_owner(ctx: Context<SetConfig>, price_owner: Pubkey) -> Result<()> {
        check_not_launched(&ctx.accounts.config)?;
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
        check_not_launched(&ctx.accounts.config)?;
        check_address(&cash_mint)?;
        let config = &mut ctx.accounts.config;
        emit!(CashMintSet {
            old: config.cash_mint,
            new: cash_mint,
        });
        config.cash_mint = cash_mint;
        Ok(())
    }

    /// Every parameter at once, inside the hard bounds. After `launch()` the publish delay
    /// cannot go under two days.
    pub fn set_params(ctx: Context<SetConfig>, params: Params) -> Result<()> {
        let config = &mut ctx.accounts.config;
        check_params(&params, config.launched)?;
        config.apply_params(&params);
        emit!(ParamsSet { params });
        Ok(())
    }

    /// One way. Before the public link: the three addresses lock and the publish delay is
    /// raised to two days if it was under.
    pub fn launch(ctx: Context<SetConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        check_not_launched(config)?;
        config.launched = true;
        config.publish_delay_s = config.publish_delay_s.max(LAUNCHED_PUBLISH_DELAY_S);
        emit!(Launched {
            publish_delay_s: config.publish_delay_s,
        });
        Ok(())
    }

    /// First step of handing the admin over. All zeros withdraws a proposal.
    pub fn propose_admin(ctx: Context<SetConfig>, pending_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = pending_admin;
        emit!(AdminProposed { pending_admin });
        Ok(())
    }

    /// Only the admin starts the keeper again.
    pub fn unpause_keeper(ctx: Context<SetConfig>) -> Result<()> {
        ctx.accounts.config.keeper_paused = false;
        emit!(KeeperPauseSet { paused: false });
        Ok(())
    }
}

/// Second step: the proposed key takes the admin by signing. A key that cannot sign never
/// becomes the admin.
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = pending_admin
    )]
    pub config: Box<Account<'info, Config>>,
}

impl AcceptAdmin<'_> {
    pub fn handle(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        emit!(AdminChanged {
            previous_admin: config.admin,
            new_admin: config.pending_admin,
        });
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();
        Ok(())
    }
}

/// The guardian can only tighten: it stops the keeper paths and cannot start them again.
/// No owner instruction reads the switch, so a pause never stands between a person and
/// their tokens.
#[derive(Accounts)]
pub struct PauseKeeper<'info> {
    pub guardian: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = guardian
    )]
    pub config: Box<Account<'info, Config>>,
}

impl PauseKeeper<'_> {
    pub fn handle(ctx: Context<PauseKeeper>) -> Result<()> {
        ctx.accounts.config.keeper_paused = true;
        emit!(KeeperPauseSet { paused: true });
        Ok(())
    }
}
