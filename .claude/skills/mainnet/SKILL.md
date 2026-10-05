---
name: mainnet
description: The checklist for any action that touches real money on a live chain. A person runs the action; this prepares it and records it.
argument-hint: "[what is to be done on mainnet]"
disable-model-invocation: true
---

To prepare: $ARGUMENTS

An agent never sends a mainnet transaction and never holds a funded key. This checklist gets everything ready, then hands over.

1. **State it plainly:** which chain, which wallet, what the transaction does, the largest amount that can leave the wallet, and what success looks like.
2. **Dry run first.** Simulate it, or run it on a fork, and show the result: the accounts or contracts touched, the balance changes, the fee.
3. **Smallest sensible amount,** from the demo wallet only.
4. **Print the exact command** for the person to run, in a `bash` block. Do not run it.
5. **After the person runs it,** record in `docs/vault/STATE-VAULT.md`: the signature or transaction hash, the explorer link, the amount, the date.
6. **If it reverted,** record the error and stop. It is never sent again as it was; a new attempt is a new, deliberate action.
