//! Placeholder until the tests are written: the vault program follows them.
use anchor_lang::prelude::*;

declare_id!("529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW");

#[program]
pub mod basket {
    use super::*;

    pub fn placeholder(_ctx: Context<Placeholder>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Placeholder {}
