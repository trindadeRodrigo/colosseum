use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::checks::{check_address, check_params, check_router, LAUNCHED_PUBLISH_DELAY_S};
use crate::errors::BasketError;
use crate::events::{
    AdminChanged, AdminProposed, CashMintSet, ClosedDaySet, ClosedUntilSet, GuardianSet,
    KeeperPauseSet, KeeperSet, Launched, ParamsSet, PriceOwnerSet, RouterSet,
};
use crate::program::Basket;
use crate::state::{Config, Params, CONFIG_SEED};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct InitConfigArgs {
    pub guardian: Pubkey,
    pub default_keeper: Pubkey,
    pub router_program: Pubkey,
    pub price_owner: Pubkey,
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
    /// The one mint a vault takes as a deposit. It has to be a mint of a token program: an
    /// address that is not one, locked in by `launch()`, would mean no deposits until an
    /// upgrade.
    pub cash_mint: InterfaceAccount<'info, Mint>,
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
        check_router(&args.router_program)?;
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.authority.key();
        config.guardian = args.guardian;
        config.default_keeper = args.default_keeper;
        config.router_program = args.router_program;
        config.price_owner = args.price_owner;
        config.cash_mint = ctx.accounts.cash_mint.key();
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

    /// A new guardian, at any time: a key that pauses and vetoes has to be replaceable
    /// without an upgrade.
    pub fn set_guardian(ctx: Context<SetConfig>, guardian: Pubkey) -> Result<()> {
        check_address(&guardian)?;
        let config = &mut ctx.accounts.config;
        emit!(GuardianSet {
            old: config.guardian,
            new: guardian,
        });
        config.guardian = guardian;
        Ok(())
    }

    /// A new default keeper, at any time. A vault that names no keeper of its own is traded
    /// by this one from the next transaction on.
    pub fn set_default_keeper(ctx: Context<SetConfig>, keeper: Pubkey) -> Result<()> {
        check_address(&keeper)?;
        let config = &mut ctx.accounts.config;
        emit!(KeeperSet {
            old: config.default_keeper,
            new: keeper,
        });
        config.default_keeper = keeper;
        Ok(())
    }

    /// The time before which the stock market counts as closed. The admin may set any
    /// time, an earlier one included: it is how a halt the guardian called is lifted.
    pub fn set_closed_until(ctx: Context<SetConfig>, closed_until: i64) -> Result<()> {
        ctx.accounts.config.closed_until = closed_until;
        emit!(ClosedUntilSet { closed_until });
        Ok(())
    }

    /// Closes a day (days since 1970, UTC) or opens it again.
    pub fn set_closed_day(ctx: Context<SetConfig>, day: u16, closed: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if closed {
            config.close_day(day)?;
        } else {
            config.open_day(day)?;
        }
        emit!(ClosedDaySet { day, closed });
        Ok(())
    }
}

/// The admin changes the cash mint, until `launch()`. The new one comes in as an account
/// and has to be a mint of a token program.
#[derive(Accounts)]
pub struct SetCashMint<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
    pub cash_mint: InterfaceAccount<'info, Mint>,
}

impl SetCashMint<'_> {
    pub fn set_cash_mint(ctx: Context<SetCashMint>) -> Result<()> {
        check_not_launched(&ctx.accounts.config)?;
        let cash_mint = ctx.accounts.cash_mint.key();
        let config = &mut ctx.accounts.config;
        emit!(CashMintSet {
            old: config.cash_mint,
            new: cash_mint,
        });
        config.cash_mint = cash_mint;
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

/// Any call by the guardian. The guardian can only tighten: it stops the keeper paths and
/// cannot start them again, pushes `closed_until` later and never earlier, closes a day
/// and never opens one. No owner instruction reads any of it, so nothing here stands
/// between a person and their tokens.
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

    /// Only a later time than the one stored.
    pub fn extend_closed_until(ctx: Context<PauseKeeper>, closed_until: i64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            closed_until > config.closed_until,
            BasketError::ParamOutOfBounds
        );
        config.closed_until = closed_until;
        emit!(ClosedUntilSet { closed_until });
        Ok(())
    }

    pub fn add_closed_day(ctx: Context<PauseKeeper>, day: u16) -> Result<()> {
        ctx.accounts.config.close_day(day)?;
        emit!(ClosedDaySet { day, closed: true });
        Ok(())
    }
}
