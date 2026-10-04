use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::checks::{
    check_cooldown, check_inside_band, check_keeper, check_keeper_mint, check_loss_cap,
    check_market, check_route_selector, check_router, check_toward_target, check_untampered,
    check_value, decayed_loss, refuse_other_vault_accounts, token_view,
};
use crate::errors::BasketError;
use crate::events::KeeperTrade;
use crate::price::{reference, value_in_cash, value_of_others, Reference};
use crate::state::{AssetRegistry, Config, Vault, ASSETS_SEED, BPS, CONFIG_SEED, VAULT_SEED};

/// Keeper: one trade in a vault whose owner switched auto-follow on, through the router in
/// Config, signed by the vault. The keeper names how much may be spent; the least that
/// must come back is worked out here, from the price reference.
///
/// One side of the trade is cash and the other is one of the vault's positions. Everything
/// the owner's swap checks around the router's call is checked here too, and then the
/// keeper's own rules (DESIGN-VAULT.md section 5).
#[derive(Accounts)]
pub struct KeeperLeg<'info> {
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
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
    #[account(mint::token_program = output_token_program)]
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
    /// CHECK: read by hand in Scope's layout. It has to be owned by Config's price program,
    /// and to be the account the asset list names for each asset that is valued.
    #[account(owner = config.price_owner @ BasketError::AssetNotPriced)]
    pub price_account: UncheckedAccount<'info>,
}

/// What the leg knows before the router is called.
struct Before {
    /// True when cash goes out and the asset comes in.
    buying: bool,
    asset_mint: Pubkey,
    asset_decimals: u8,
    cash_decimals: u8,
    target_bps: u16,
    price: Reference,
    /// The value of every other position, in raw units of the cash mint.
    others: u128,
}

impl<'info> KeeperLeg<'info> {
    /// Checks 1, 2, 6, 8, 9, 10 and 11, and the valuation the others need.
    fn before(&self, now: i64) -> Result<Before> {
        check_keeper(self.keeper.key, &self.vault, &self.config)?;
        require!(self.vault.auto_follow, BasketError::AutoFollowOff);
        require!(!self.config.keeper_paused, BasketError::KeeperPaused);

        // Cash on one side, and one side only: the other is the asset the leg trades. A mint
        // traded for itself is cash on both sides or on neither.
        let input_is_cash = self.input_mint.key() == self.config.cash_mint;
        let output_is_cash = self.output_mint.key() == self.config.cash_mint;
        require!(input_is_cash != output_is_cash, BasketError::NotCashLeg);
        let (asset, cash) = if input_is_cash {
            (&self.output_mint, &self.input_mint)
        } else {
            (&self.input_mint, &self.output_mint)
        };
        let asset_mint = asset.key();

        // Only what the owner agreed to hold: a position of the vault.
        let position = self
            .vault
            .position(&asset_mint)
            .ok_or(BasketError::MintNotAccepted)?;
        check_cooldown(position.last_keeper_ts, self.config.asset_cooldown_s, now)?;
        check_keeper_mint(&asset.to_account_info(), now)?;

        let registry = self.assets.load()?;
        let entry = registry
            .find(&asset_mint)
            .ok_or(BasketError::MintNotAccepted)?;
        check_market(entry.session, &self.config, now)?;
        let prices = self.price_account.try_borrow_data()?;
        let price = reference(
            &prices,
            self.price_account.key,
            &registry,
            entry,
            &self.config,
            now,
        )?;
        let others = value_of_others(
            &self.vault,
            &asset_mint,
            &prices,
            self.price_account.key,
            &registry,
            &self.config,
            cash.decimals,
            now,
        )?;
        Ok(Before {
            buying: input_is_cash,
            asset_mint,
            asset_decimals: asset.decimals,
            cash_decimals: cash.decimals,
            target_bps: position.target_bps,
            price,
            others,
        })
    }

    pub fn handle(
        ctx: Context<'_, '_, '_, 'info, KeeperLeg<'info>>,
        amount_in: u64,
        data: Vec<u8>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let accounts = ctx.accounts;
        let before = accounts.before(now)?;
        let vault_key = accounts.vault.key();
        let input_key = accounts.vault_input.key();
        let output_key = accounts.vault_output.key();

        check_router(accounts.router_program.key)?;
        check_route_selector(&data)?;
        refuse_other_vault_accounts(ctx.remaining_accounts, &vault_key, &input_key, &output_key)?;

        let input_info = accounts.vault_input.to_account_info();
        let output_info = accounts.vault_output.to_account_info();
        let input_before = token_view(&input_info).ok_or(BasketError::AccountTampered)?;
        let output_before = token_view(&output_info).ok_or(BasketError::AccountTampered)?;

        // What the vault holds of the asset and of cash, by its own two accounts, and what
        // everything is worth, before the trade.
        let in_cash = |amount: u64| {
            value_in_cash(
                amount,
                &before.price,
                before.asset_decimals,
                before.cash_decimals,
            )
        };
        let (asset_held, cash_held) = if before.buying {
            (output_before.amount, input_before.amount)
        } else {
            (input_before.amount, output_before.amount)
        };
        let asset_value = in_cash(asset_held)?;
        let vault_value = before
            .others
            .checked_add(asset_value)
            .and_then(|value| value.checked_add(cash_held as u128))
            .ok_or(BasketError::AssetNotPriced)?;
        check_toward_target(before.buying, asset_value, vault_value, before.target_bps)?;

        // The router gets the accounts as the keeper listed them, with one signature: the
        // vault's. The keeper's own signature is never passed on, and the vault account is
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
        require!(spent <= amount_in, BasketError::SpentTooMuch);
        let received = output_after
            .checked_sub(output_before.amount)
            .ok_or(BasketError::ReceivedTooLittle)?;

        // Check 4: what came in against what went out, at the reference price.
        let (spent_value, received_value, asset_after, cash_after) = if before.buying {
            (spent as u128, in_cash(received)?, output_after, input_after)
        } else {
            (in_cash(spent)?, received as u128, input_after, output_after)
        };
        check_value(spent_value, received_value, accounts.config.tolerance_bps)?;

        // Check 5: where the asset sits after the trade.
        let asset_value_after = in_cash(asset_after)?;
        let vault_value_after = before
            .others
            .checked_add(asset_value_after)
            .and_then(|value| value.checked_add(cash_after as u128))
            .ok_or(BasketError::AssetNotPriced)?;
        check_inside_band(
            before.buying,
            asset_value_after,
            vault_value_after,
            before.target_bps,
            accounts.config.band_bps,
        )?;

        // Check 7: what the leg lost is added to what is left of the week's losses. A leg
        // that lost nothing is not held to the cap and does not touch the counter.
        let loss = spent_value.saturating_sub(received_value);
        let vault = &mut accounts.vault;
        let loss_used = (decayed_loss(vault.loss_accum, vault.loss_ts, now) as u128)
            .checked_add(loss)
            .ok_or(BasketError::LossCapReached)?;
        if loss > 0 {
            check_loss_cap(loss_used, vault_value, accounts.config.loss_cap_bps)?;
            vault.loss_accum = u64::try_from(loss_used).map_err(|_| BasketError::LossCapReached)?;
            vault.loss_ts = now;
        }

        vault.record_balance(&before.asset_mint, asset_after);
        vault.stamp_keeper(&before.asset_mint, now);

        // An empty vault has lost nothing; a share that does not fit is shown as the most.
        let loss_used_bps = match loss_used.checked_mul(BPS as u128) {
            Some(scaled) if vault_value > 0 => (scaled / vault_value).min(u16::MAX as u128) as u16,
            Some(_) => 0,
            None => u16::MAX,
        };
        emit!(KeeperTrade {
            vault: vault_key,
            mint_in: accounts.input_mint.key(),
            mint_out: accounts.output_mint.key(),
            spent,
            received,
            loss: u64::try_from(loss).unwrap_or(u64::MAX),
            loss_used_bps,
        });
        msg!("keeper leg: spent={} received={}", spent, received);
        Ok(())
    }
}
