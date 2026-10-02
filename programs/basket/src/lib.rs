//! The vault program: one vault per person per plan, on Solana.
//!
//! This is the owner path only: initialise the config, create a vault, deposit cash, and
//! withdraw the tokens themselves to the owner. The swap, the shared-portfolio registry,
//! the keeper leg, pause and auto-follow are later instructions on the same accounts.
//! The design is docs/vault/DESIGN-VAULT.md, sections 3.7, 5 and 13.

use anchor_lang::prelude::*;

pub mod checks;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod transfer;

pub use instructions::*;
pub use state::{Params, Target};

declare_id!("529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW");

#[program]
pub mod basket {
    use super::*;

    /// Admin, once. The signer must be the program's upgrade authority and becomes the admin.
    pub fn init_config(ctx: Context<InitConfig>, args: InitConfigArgs) -> Result<()> {
        InitConfig::handle(ctx, args)
    }

    /// Admin. The one program a vault may swap through: Jupiter on mainnet, the test
    /// exchange on devnet.
    pub fn set_router(ctx: Context<SetConfig>, router_program: Pubkey) -> Result<()> {
        SetConfig::set_router(ctx, router_program)
    }

    /// Admin. The program that must own a price account for the vault to read it:
    /// Kamino Scope on mainnet, the test price program on devnet.
    pub fn set_price_owner(ctx: Context<SetConfig>, price_owner: Pubkey) -> Result<()> {
        SetConfig::set_price_owner(ctx, price_owner)
    }

    /// Admin. The one mint a vault takes as a deposit: the chain's dollar token.
    pub fn set_cash_mint(ctx: Context<SetConfig>, cash_mint: Pubkey) -> Result<()> {
        SetConfig::set_cash_mint(ctx, cash_mint)
    }

    /// Owner. One vault per owner per plan id.
    pub fn create_vault(
        ctx: Context<CreateVault>,
        basket_id: u64,
        targets: Vec<Target>,
        auto_follow: bool,
        expected_version: u32,
    ) -> Result<()> {
        CreateVault::handle(ctx, basket_id, targets, auto_follow, expected_version)
    }

    /// Owner. Cash only: the mint must be Config's cash mint. Into the vault's associated
    /// token account.
    pub fn deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, Deposit<'info>>,
        amount: u64,
    ) -> Result<()> {
        Deposit::handle(ctx, amount)
    }

    /// Owner. Any token the vault holds, one mint per call, in kind, to a token account the
    /// owner owns. Reads no config, registry or price: nothing but an upgrade can block it.
    pub fn withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, Withdraw<'info>>,
        amount: u64,
    ) -> Result<()> {
        Withdraw::handle(ctx, amount)
    }
}
