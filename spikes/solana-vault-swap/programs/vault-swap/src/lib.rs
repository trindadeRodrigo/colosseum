//! Throwaway spike. Not the product's vault: no recipe, no keeper role, no oracle.
//! It answers one question: can a PDA vault swap USDC -> SPYx (Token-2022) through
//! Jupiter by CPI, with the vault measuring its own balances before and after?

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("78mDDDYW2yEz9qmNeLbgCAcsKH7CrqmYDPtNUpVhUHic");

pub const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod vault_swap {
    use super::*;

    pub fn create_vault(ctx: Context<CreateVault>, basket_id: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.basket_id = basket_id;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    /// Forwards Jupiter's instruction bytes and accounts, signed by the vault PDA.
    /// The vault ignores what Jupiter reports and checks its own token accounts.
    pub fn swap(ctx: Context<Swap>, max_in: u64, min_out: u64, data: Vec<u8>) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        let in_key = ctx.accounts.vault_input_token_account.key();
        let out_key = ctx.accounts.vault_output_token_account.key();
        require_keys_neq!(in_key, out_key, VaultError::SameAccount);

        let in_before = ctx.accounts.vault_input_token_account.amount;
        let out_before = ctx.accounts.vault_output_token_account.amount;

        // Any other writable token account owned by the vault that the route touches.
        // The PDA signs the whole CPI, so a crafted route could debit one of them.
        let mut others: Vec<(usize, u64)> = Vec::new();
        for (i, acc) in ctx.remaining_accounts.iter().enumerate() {
            if !acc.is_writable || acc.key() == in_key || acc.key() == out_key {
                continue;
            }
            if let Some((owner, amount)) = read_token_account(acc) {
                if owner == vault_key {
                    others.push((i, amount));
                }
            }
        }

        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|acc| AccountMeta {
                pubkey: acc.key(),
                is_signer: acc.key() == vault_key,
                is_writable: acc.is_writable,
            })
            .collect();

        let owner_key = ctx.accounts.vault.owner;
        let basket_id = ctx.accounts.vault.basket_id.to_le_bytes();
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, owner_key.as_ref(), &basket_id, &bump];

        invoke_signed(
            &Instruction {
                program_id: JUPITER_V6,
                accounts: metas,
                data,
            },
            ctx.remaining_accounts,
            &[seeds],
        )?;

        ctx.accounts.vault_input_token_account.reload()?;
        ctx.accounts.vault_output_token_account.reload()?;
        let in_acc = &ctx.accounts.vault_input_token_account;
        let out_acc = &ctx.accounts.vault_output_token_account;

        let spent = in_before.saturating_sub(in_acc.amount);
        let received = out_acc.amount.saturating_sub(out_before);
        require!(spent <= max_in, VaultError::SpentTooMuch);
        require!(received >= min_out, VaultError::ReceivedTooLittle);

        for acc in [in_acc, out_acc] {
            require_keys_eq!(acc.owner, vault_key, VaultError::AccountTampered);
            require!(acc.delegate.is_none(), VaultError::AccountTampered);
            require!(acc.close_authority.is_none(), VaultError::AccountTampered);
        }

        for (i, before) in others {
            let acc = &ctx.remaining_accounts[i];
            let (owner, after) = read_token_account(acc).ok_or(VaultError::AccountTampered)?;
            require_keys_eq!(owner, vault_key, VaultError::AccountTampered);
            require!(after >= before, VaultError::OtherAccountDebited);
        }

        msg!("vault swap: spent={} received={}", spent, received);
        Ok(())
    }

    /// Owner pulls tokens out in kind. Touches no router, oracle or keeper.
    pub fn withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, Withdraw<'info>>,
        amount: u64,
    ) -> Result<()> {
        let owner_key = ctx.accounts.vault.owner;
        let basket_id = ctx.accounts.vault.basket_id.to_le_bytes();
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[VAULT_SEED, owner_key.as_ref(), &basket_id, &bump];
        let signer: &[&[&[u8]]] = &[seeds];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer,
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.mint.decimals,
        )
    }
}

/// (owner, amount) if the account is a token account of either token program.
/// Token-2022 accounts carry a type byte at offset 165 (2 = account); mints never
/// reach this branch as an "owner == vault" match because bytes 32..64 of a mint
/// are part of the authority/supply fields.
fn read_token_account(acc: &AccountInfo) -> Option<(Pubkey, u64)> {
    if *acc.owner != TOKEN_PROGRAM && *acc.owner != TOKEN_2022_PROGRAM {
        return None;
    }
    let data = acc.try_borrow_data().ok()?;
    if data.len() < 165 {
        return None;
    }
    if data.len() > 165 && data[165] != 2 {
        return None;
    }
    let owner = Pubkey::new_from_array(data[32..64].try_into().ok()?);
    let amount = u64::from_le_bytes(data[64..72].try_into().ok()?);
    Some((owner, amount))
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub basket_id: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(basket_id: u64)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref(), &basket_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    /// Spike: owner only. The product adds a keeper branch with the extra rules.
    pub owner: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.basket_id.to_le_bytes()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, Vault>,
    pub input_mint: InterfaceAccount<'info, Mint>,
    pub output_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = input_mint, token::authority = vault)]
    pub vault_input_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = output_mint, token::authority = vault)]
    pub vault_output_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: address-checked; only CPI target.
    #[account(address = JUPITER_V6)]
    pub jupiter_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.basket_id.to_le_bytes()],
        bump = vault.bump,
        has_one = owner
    )]
    pub vault: Account<'info, Vault>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = vault, token::token_program = token_program)]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum VaultError {
    #[msg("input and output token accounts are the same")]
    SameAccount,
    #[msg("vault input account decreased by more than max_in")]
    SpentTooMuch,
    #[msg("vault output account increased by less than min_out")]
    ReceivedTooLittle,
    #[msg("another vault token account decreased")]
    OtherAccountDebited,
    #[msg("owner, delegate or close authority changed on a vault token account")]
    AccountTampered,
}
