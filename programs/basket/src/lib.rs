//! The vault program: one vault per person per plan, on Solana.
//!
//! The owner path (create, deposit cash, swap through the one allowed router, set targets,
//! withdraw the tokens themselves), the platform's asset list, the shared-portfolio registry
//! with the author limits, the keeper's one trade with its checks, the owner's consent to a
//! new version, and the admin's and the guardian's switches.
//! The design is docs/vault/DESIGN-VAULT.md, sections 3.7, 5, 6 and 13.

use anchor_lang::prelude::*;

pub mod checks;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod price;
pub mod state;
pub mod transfer;

pub use instructions::*;
pub use state::{Component, Params, Target};

declare_id!("529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW");

#[program]
pub mod basket {
    use super::*;

    /// Admin, once. The signer must be the program's upgrade authority and becomes the admin.
    pub fn init_config(ctx: Context<InitConfig>, args: InitConfigArgs) -> Result<()> {
        InitConfig::handle(ctx, args)
    }

    /// Admin, until `launch()`. The one program a vault may swap through: Jupiter on
    /// mainnet, the test exchange on devnet.
    pub fn set_router(ctx: Context<SetConfig>, router_program: Pubkey) -> Result<()> {
        SetConfig::set_router(ctx, router_program)
    }

    /// Admin, until `launch()`. The program that must own a price account for the vault to
    /// read it: Kamino Scope on mainnet, the test price program on devnet.
    pub fn set_price_owner(ctx: Context<SetConfig>, price_owner: Pubkey) -> Result<()> {
        SetConfig::set_price_owner(ctx, price_owner)
    }

    /// Admin, until `launch()`. The one mint a vault takes as a deposit: the chain's dollar
    /// token, passed as an account, which has to be a mint of a token program.
    pub fn set_cash_mint(ctx: Context<SetCashMint>) -> Result<()> {
        SetCashMint::set_cash_mint(ctx)
    }

    /// Admin. Every parameter, inside the hard bounds.
    pub fn set_params(ctx: Context<SetConfig>, params: Params) -> Result<()> {
        SetConfig::set_params(ctx, params)
    }

    /// Admin, one way. Locks the router, the price owner, the cash mint and the price
    /// accounts of the asset list, and raises the floor on the publish delay to two days.
    pub fn launch(ctx: Context<SetConfig>) -> Result<()> {
        SetConfig::launch(ctx)
    }

    /// Admin. Names the key that may take the admin over.
    pub fn propose_admin(ctx: Context<SetConfig>, pending_admin: Pubkey) -> Result<()> {
        SetConfig::propose_admin(ctx, pending_admin)
    }

    /// The proposed key. Takes the admin over.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        AcceptAdmin::handle(ctx)
    }

    /// Guardian. Stops the keeper paths. The owner path reads no such switch.
    pub fn pause_keeper(ctx: Context<PauseKeeper>) -> Result<()> {
        PauseKeeper::handle(ctx)
    }

    /// Admin. Starts the keeper paths again.
    pub fn unpause_keeper(ctx: Context<SetConfig>) -> Result<()> {
        SetConfig::unpause_keeper(ctx)
    }

    /// Admin. A new guardian.
    pub fn set_guardian(ctx: Context<SetConfig>, guardian: Pubkey) -> Result<()> {
        SetConfig::set_guardian(ctx, guardian)
    }

    /// Admin. A new default keeper.
    pub fn set_default_keeper(ctx: Context<SetConfig>, keeper: Pubkey) -> Result<()> {
        SetConfig::set_default_keeper(ctx, keeper)
    }

    /// Admin. The time before which the stock market counts as closed, later or earlier.
    pub fn set_closed_until(ctx: Context<SetConfig>, closed_until: i64) -> Result<()> {
        SetConfig::set_closed_until(ctx, closed_until)
    }

    /// Admin. Closes a day (days since 1970, UTC) or opens it again.
    pub fn set_closed_day(ctx: Context<SetConfig>, day: u16, closed: bool) -> Result<()> {
        SetConfig::set_closed_day(ctx, day, closed)
    }

    /// Guardian. Pushes `closed_until` later, never earlier.
    pub fn extend_closed_until(ctx: Context<PauseKeeper>, closed_until: i64) -> Result<()> {
        PauseKeeper::extend_closed_until(ctx, closed_until)
    }

    /// Guardian. Closes a day (days since 1970, UTC).
    pub fn add_closed_day(ctx: Context<PauseKeeper>, day: u16) -> Result<()> {
        PauseKeeper::add_closed_day(ctx, day)
    }

    /// Admin, once. Creates the empty asset list.
    pub fn init_assets(ctx: Context<InitAssets>) -> Result<()> {
        InitAssets::handle(ctx)
    }

    /// Admin. Lists a token, or rewrites the entry of one that is listed.
    pub fn upsert_asset(ctx: Context<UpsertAsset>, args: AssetArgs) -> Result<()> {
        UpsertAsset::handle(ctx, args)
    }

    /// Admin, until `launch()`. Names the price account of one of the asset list's four
    /// slots: an account the price program owns, passed as an account.
    pub fn set_price_account(ctx: Context<SetPriceAccount>, slot: u8) -> Result<()> {
        SetPriceAccount::handle(ctx, slot)
    }

    /// Creator. The first version of a shared portfolio; it takes effect at once.
    pub fn publish_recipe(
        ctx: Context<PublishRecipe>,
        family_id: [u8; 32],
        components: Vec<Component>,
        meta_hash: [u8; 32],
        max_fee_bps: u16,
        flags: u8,
    ) -> Result<()> {
        PublishRecipe::handle(ctx, family_id, components, meta_hash, max_fee_bps, flags)
    }

    /// Creator. A later version; it takes effect one publish delay later.
    pub fn update_recipe(
        ctx: Context<UpdateRecipe>,
        components: Vec<Component>,
        meta_hash: [u8; 32],
    ) -> Result<()> {
        UpdateRecipe::handle(ctx, components, meta_hash)
    }

    /// Creator or guardian. Takes back the version that is waiting.
    pub fn cancel_pending(ctx: Context<CancelPending>) -> Result<()> {
        CancelPending::handle(ctx)
    }

    /// Owner. One vault per owner per plan id. With a shared portfolio passed, the vault
    /// takes the weights of its version in effect, if that is `expected_version`.
    pub fn create_vault(
        ctx: Context<CreateVault>,
        basket_id: u64,
        targets: Vec<Target>,
        auto_follow: bool,
        expected_version: u32,
    ) -> Result<()> {
        CreateVault::handle(ctx, basket_id, targets, auto_follow, expected_version)
    }

    /// Owner. The vault's own targets; it stops following a shared portfolio.
    pub fn set_targets(ctx: Context<SetTargets>, targets: Vec<Target>) -> Result<()> {
        SetTargets::handle(ctx, targets)
    }

    /// Owner. Takes the version in effect of a shared portfolio, if its number is
    /// `expected_version`: the vault follows that portfolio from then on.
    pub fn accept_version(ctx: Context<AcceptVersion>, expected_version: u32) -> Result<()> {
        AcceptVersion::handle(ctx, expected_version)
    }

    /// Owner. Lets the keeper trade the vault toward its targets, or stops it.
    pub fn set_auto_follow(ctx: Context<SetAutoFollow>, on: bool) -> Result<()> {
        SetAutoFollow::handle(ctx, on)
    }

    /// Anyone. Moves an auto-follow vault to the version in effect of the portfolio it
    /// follows, when the version brings in no asset the owner has not accepted.
    pub fn adopt_version(ctx: Context<AdoptVersion>) -> Result<()> {
        AdoptVersion::handle(ctx)
    }

    /// The vault's owner or its keeper. Records what the vault's own token accounts hold.
    /// The accounts after Config are those token accounts.
    pub fn sync_balances<'info>(
        ctx: Context<'_, '_, '_, 'info, SyncBalances<'info>>,
    ) -> Result<()> {
        SyncBalances::handle(ctx)
    }

    /// Keeper. One trade of an auto-follow vault through Config's router, signed by the
    /// vault: cash for one of its positions or the other way, toward the target, at most
    /// `amount_in` spent, and at least the reference price less the tolerance received.
    /// `data` and the remaining accounts are the router's instruction.
    pub fn keeper_leg<'info>(
        ctx: Context<'_, '_, '_, 'info, KeeperLeg<'info>>,
        amount_in: u64,
        data: Vec<u8>,
    ) -> Result<()> {
        KeeperLeg::handle(ctx, amount_in, data)
    }

    /// Owner. Cash only: the mint must be Config's cash mint. Into the vault's associated
    /// token account.
    pub fn deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, Deposit<'info>>,
        amount: u64,
    ) -> Result<()> {
        Deposit::handle(ctx, amount)
    }

    /// Owner. One trade through Config's router, signed by the vault: at most `max_in` of
    /// the input leaves and at least `min_out` of the output arrives, by the vault's own
    /// count. `data` and the remaining accounts are the router's instruction.
    pub fn owner_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, OwnerSwap<'info>>,
        max_in: u64,
        min_out: u64,
        data: Vec<u8>,
    ) -> Result<()> {
        OwnerSwap::handle(ctx, max_in, min_out, data)
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
