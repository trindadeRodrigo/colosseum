use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::checks::{
    check_route_selector, check_router, check_untampered, refuse_other_vault_accounts, token_view,
};
use crate::errors::BasketError;
use crate::state::{AssetRegistry, Config, Vault, ASSETS_SEED, CONFIG_SEED, VAULT_SEED};

/// Owner: one trade through the router in Config, signed by the vault. The instruction
/// bytes and the router's accounts come from the client. Nothing the router reports is
/// believed: the program reads the vault's own token accounts before and after.
///
/// No price account and no keeper switch: a pause or a dead feed cannot block the owner.
#[derive(Accounts)]
pub struct OwnerSwap<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Box<Account<'info, Vault>>,
    /// Read for the router and the cash mint. Only the one Config, at its own address.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ASSETS_SEED],
        bump
    )]
    pub assets: AccountLoader<'info, AssetRegistry>,
    #[account(mint::token_program = input_token_program)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mint::token_program = output_token_program,
        constraint = output_mint.key() != input_mint.key() @ BasketError::SameMint
    )]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    /// What the vault spends from: its associated token account for the input mint.
    #[account(
        mut,
        associated_token::mint = input_mint,
        associated_token::authority = vault,
        associated_token::token_program = input_token_program
    )]
    pub vault_input: Box<InterfaceAccount<'info, TokenAccount>>,
    /// What the vault is paid into: its associated token account for the output mint.
    #[account(
        mut,
        associated_token::mint = output_mint,
        associated_token::authority = vault,
        associated_token::token_program = output_token_program
    )]
    pub vault_output: Box<InterfaceAccount<'info, TokenAccount>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
    /// CHECK: the one program Config allows, by address.
    #[account(address = config.router_program @ BasketError::RouterNotAllowed)]
    pub router_program: UncheckedAccount<'info>,
}

impl<'info> OwnerSwap<'info> {
    pub fn handle(
        ctx: Context<'_, '_, '_, 'info, OwnerSwap<'info>>,
        max_in: u64,
        min_out: u64,
        data: Vec<u8>,
    ) -> Result<()> {
        let accounts = ctx.accounts;
        let vault_key = accounts.vault.key();
        let input_key = accounts.vault_input.key();
        let output_key = accounts.vault_output.key();
        let output_mint = accounts.output_mint.key();

        check_router(accounts.router_program.key)?;
        check_route_selector(&data)?;
        // The vault buys what the platform lists, or goes back to cash.
        require!(
            output_mint == accounts.config.cash_mint
                || accounts.assets.load()?.is_listed(&output_mint),
            BasketError::MintNotAccepted
        );
        refuse_other_vault_accounts(ctx.remaining_accounts, &vault_key, &input_key, &output_key)?;

        let input_info = accounts.vault_input.to_account_info();
        let output_info = accounts.vault_output.to_account_info();
        let input_before = token_view(&input_info).ok_or(BasketError::AccountTampered)?;
        let output_before = token_view(&output_info).ok_or(BasketError::AccountTampered)?;

        // The router gets the accounts as the client listed them, with one signature: the
        // vault's. The owner's own signature is never passed on, and the vault account is
        // handed over read-only.
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|account| AccountMeta {
                pubkey: *account.key,
                is_signer: *account.key == vault_key,
                is_writable: account.is_writable && *account.key != vault_key,
            })
            .collect();
        let owner = accounts.vault.owner;
        let basket_id = accounts.vault.basket_id.to_le_bytes();
        let bump = [accounts.vault.bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &basket_id, &bump];
        invoke_signed(
            &Instruction {
                program_id: accounts.router_program.key(),
                accounts: metas,
                data,
            },
            ctx.remaining_accounts,
            &[seeds],
        )?;

        let input_after = check_untampered(&input_info, &input_before, &vault_key)?;
        let output_after = check_untampered(&output_info, &output_before, &vault_key)?;
        refuse_other_vault_accounts(ctx.remaining_accounts, &vault_key, &input_key, &output_key)?;

        let spent = input_before.amount.saturating_sub(input_after);
        require!(spent <= max_in, BasketError::SpentTooMuch);
        let received = output_after
            .checked_sub(output_before.amount)
            .ok_or(BasketError::ReceivedTooLittle)?;
        require!(received >= min_out, BasketError::ReceivedTooLittle);

        accounts
            .vault
            .record_balance(&accounts.input_mint.key(), input_after);
        accounts.vault.record_balance(&output_mint, output_after);
        msg!("owner swap: spent={} received={}", spent, received);
        Ok(())
    }
}
