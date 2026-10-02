# Wallet provider for sign-in

Oct 1, 2026. Docs and npm read today; no accounts created, nothing signed. Anything not confirmed in a primary source is marked [unverified].

## Answer

- **Primary: Privy.** The only candidate where every requirement is documented: sign up with a passkey alone, embedded wallets on Solana and EVM, any EVM chain through viem `defineChain`, delegated server signing with policies on both chain families, key export, and a device-flow "agent authorization" plus a CLI so an outside agent can use a user's wallet. Robinhood's own docs list Privy for chain 4663. Free under 500 MAU.
- **Fallback: Turnkey.** Passkey is the native authenticator, one wallet holds a secp256k1 and an ed25519 account, it signs at curve level so chain id does not matter, and its policy engine parses both EVM and Solana transactions. More wiring (you bring viem and web3.js and your own RPC) and it bills per signature.
- **Not Swig for sign-in.** It would give Solana users a smart-wallet PDA and EVM users something else, needs our own passkey UI and a fee payer, and adds a CPI level. An embedded wallet from Privy or Turnkey is a plain keypair, so the vault `owner` is an ordinary address on every chain, identical to a connected Phantom or MetaMask. This replaces the "Swig as the passkey wallet" line in `research/vaults/solana-feasibility.md`.
- **Phantom Connect is closed to new apps,** and has been since at least Aug 30, not Sep 28. Connecting an existing Phantom wallet through the Solana wallet standard is unaffected and needs no portal account.

## Comparison

| Provider | Passkey-only creation | Solana | Custom EVM (4663) | Server / delegated signing | Export | Free tier | React SDK | Integrate |
|---|---|---|---|---|---|---|---|---|
| **Privy** | Yes: `useSignupWithPasskey`, dashboard toggle | Yes, embedded + wallet-standard connect | Yes, `defineChain` + `supportedChains`; listed in Robinhood docs | Session signers (`addSigners` with `policyIds`), server SDK `@privy-io/node`, agent authorization (OAuth device flow, 30-day grant, revocable), `@privy-io/agent-wallet-cli` | `useExportWallet`, both chains | 0-499 MAU free, 50K signatures and $1M volume a month; $299/mo from 500 MAU. Policy engine shown as an add-on [unverified whether free] | `@privy-io/react-auth` 3.46.0, published Sep 28 | 0.5 day |
| **Turnkey** | Yes: `signUpWithPasskey`; passkey is the sub-org's authenticator | Yes, ed25519; legacy, v0 and v1 transactions; enclave parser; fee sponsorship | Yes, curve-level signing, "all EVM and SVM chains"; you broadcast | Delegated access user + policies (`eth.tx.to`, selector, `eth.tx.chain_id`; Solana instruction fields); agent skills repo | Yes | 25 signatures/mo free, then $0.10 each; Pro $99/mo at $0.05 | `@turnkey/react-wallet-kit` 2.5.2, published Sep 30; also connects external wallets | 1 day |
| **Dynamic** (Fireblocks) | `signInWithPasskey` exists as 1FA; whether a new user can register with a passkey alone is [unverified] | Yes | "EVM (all EVM networks)"; listed in Robinhood docs | Delegated access, EVM and Solana | Yes [unverified page] | Up to 1,000 MAU free; $249/mo to 5,000 | `@dynamic-labs/sdk-react-core` 5.9.2, large | 0.5-1 day |
| **Para** | No: user identifies by email, phone or social first; the passkey then guards the device share | Yes | Any EVM chain by chain id + RPC | Server SDK, pregenerated wallets, permissions (guardrails / requests) on EVM and Solana | Yes | 1,200 MAU free; $200/mo Starter. Pricing page lists native passkeys and pregen under paid plans [unverified reading] | `@getpara/react-sdk` 3.20.0 | 0.5-1 day |
| **Coinbase CDP Embedded** | No passkey. Email or SMS OTP, Google/Apple/X/Telegram, SIWE, custom JWT; TOTP for MFA | Yes | "All EVM-compatible networks"; sign and broadcast yourself off the built-in list [unverified for 4663] | Separate server wallets; policies | Yes, user only | 5,000 wallet operations/mo free, then $0.005 | `@coinbase/cdp-react` 0.0.126, pre-1.0 | 0.5 day |
| **Magic** | WebAuthn extension signs up with a passkey; whether that pairs with the Solana extension is [unverified] | Yes, extension | Custom node config [unverified today] | Server wallets (TEE) product, separate | Yes | 1,000 MAW free; $99/mo to 2,500 | `magic-sdk` 33.13.0 | 1 day |
| **Web3Auth** (MetaMask Embedded Wallets) | No: first login is OAuth, the passkey is registered afterwards; passkeys on paid plans | Yes | Yes, custom chain config | No user-wallet delegation found | Yes | 1,000 MAW free; Growth $69/mo | `@web3auth/modal` 11.4.2 | 1 day |
| **Swig** | Yes, secp256r1 authority via `PasskeyManager`; own UI, no hosted sign-in | Yes | "Swig on EVM" exists but needs "a compatible Swig deployment from your operator"; chains unlisted | Roles and session authorities, onchain | n/a (smart wallet) | Paymaster/portal pricing not public | `@swig-wallet/kit` 2.1.0, last published Jun 6 | 2+ days, Solana only |
| **Phantom Connect** | No. Google and Apple | Yes | Solana, Ethereum, Bitcoin, Base, Polygon, HyperEVM; 4663 embedded [unverified] | Phantom MCP server for agents | In Phantom | Free | `@phantom/react-sdk` 2.0.3 | Blocked: no new App IDs |

## Checks done today

- Robinhood Chain public RPC answers `eth_chainId` = `0x1237` (4663). chainid.network lists 4663 and testnet 46630, so viem `defineChain` has everything it needs.
- `@privy-io/react-auth@3.46.0` type files export `useSignupWithPasskey`, `useLoginWithPasskey`, `useSigners` / `addSigners` / `removeSigners`, `useExportWallet`. No built-in 4663 chain in `@privy-io/chains` 0.6.1; define it.
- `@turnkey/react-wallet-kit@2.5.2` contains `signUpWithPasskey`, `loginWithPasskey`, `exportWallet`, `connectWalletAccount`, `ADDRESS_FORMAT_SOLANA`. Docs show one `walletAccounts` array creating an Ethereum and a Solana account at passkey sign-up.
- Phantom: docs banner says "Phantom Portal is not accepting new applications at this time"; existing App IDs unaffected. A Solana Foundation template issue observed the closed portal on 2026-08-30 and quotes "email partnerships@phantom.app".

## What agents need (the "easy for agents" requirement)

Agents have no passkey. Three paths, all compatible with the Privy choice:

1. **Agent brings its own key.** The vault owner is any address, and the adapter's `build*` calls already return unsigned transactions. Expose those through the API (and an MCP server) and any agent wallet works: a raw keypair, Privy agentic wallet, Turnkey, CDP Agentic Wallet, Phantom MCP. This is the main path and costs nothing extra if the API never assumes a browser wallet.
2. **Agent acts for a human user.** Privy agent authorization: the agent shows a code, the user approves in the browser, the agent gets a 30-day revocable grant and signs through Privy. The CLI covers Ethereum and Solana. Scope it with a policy that allowlists our vault program and contracts.
3. **Server-side signing for a user** (session signers) is not needed for auto-follow, because the keeper has its own key and the vault checks its trades. Keep it out of the MVP.

## The spike

`spikes/wallet-provider/`, about 2-3 hours once an App ID exists. Steps 1-4 need no funds.

1. Next.js page with `PrivyProvider`: login methods passkey and wallet; embedded wallets created on login for Ethereum and Solana; `supportedChains` = Base and a `defineChain` for 4663 (RPC `https://rpc.mainnet.chain.robinhood.com`, ETH gas, Blockscout explorer).
2. `signupWithPasskey()` with no email. Pass: one EVM address and one Solana address appear.
3. Sign only: a Solana message; an EIP-1559 transaction with `chainId: 4663`, then recover the signer with viem and compare; repeat on 8453.
4. Connect Phantom (Solana) and MetaMask (EVM, add chain 4663) through the same provider and repeat step 3.
5. With about $2 of gas per chain: a 0-value self-transfer on 4663 and Base; on Solana a v0 transaction that uses an address lookup table and creates a Token-2022 token account (the shape of a Jupiter leg into the vault).
6. `useExportWallet` on both chains. Log out, log back in with the passkey on a second device.
7. Optional, for agents: run `@privy-io/agent-wallet-cli login` against the app and sign one message per chain.

Fail at 2, 3 or 5 on chain 4663 or Solana: run the same seven checks on Turnkey (`signUpWithPasskey` with the two-account `walletAccounts`, `@turnkey/viem` account on a viem client for 4663, `@turnkey/solana` signer).

## Risks to settle in the spike

- Passkeys are bound to a domain. Decide the production domain before real users create wallets; check whether a wallet made on a preview URL opens on the final one [unverified].
- A passkey-only user who loses an unsynced passkey loses the wallet. Prompt for export or a linked email after first deposit.
- Embedded wallets are plain keypairs: the user needs SOL and ETH for fees on each chain. The funding check has to include gas, not just cash.
- Privy server-side broadcast on 4663 is [unverified]; sign with Privy and broadcast through our own RPC if needed. Client-side signing does not depend on it.
- Turnkey at $0.10 a signature: a three-chain rebalance of 10 legs is about $1 per run on the pay-as-you-go plan.

## Sources

- Privy: https://docs.privy.io/authentication/user-authentication/login-methods/passkey.md , https://docs.privy.io/basics/react/advanced/configuring-evm-networks.md , https://docs.privy.io/wallets/using-wallets/signers/overview.md , https://docs.privy.io/wallets/using-wallets/signers/quickstart.md , https://docs.privy.io/recipes/agent-integrations/overview.md , https://docs.privy.io/recipes/agent-integrations/agent-authorization.md , https://docs.privy.io/recipes/agent-integrations/agent-cli.md , https://docs.privy.io/wallets/wallets/export , https://www.privy.io/pricing
- Turnkey: https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/react/sub-organization-customization , https://docs.turnkey.com/sdks/react/auth , https://docs.turnkey.com/features/networks/overview.md , https://docs.turnkey.com/features/networks/solana.md , https://docs.turnkey.com/features/policies/delegated-access/agentic-wallets.md , https://docs.turnkey.com/get-started/ai-skills.md , https://www.turnkey.com/pricing
- Para: https://docs.getpara.com/v3/introduction/chain-support.md , https://docs.getpara.com/v3/concepts/permissions.md , https://www.getpara.com/pricing
- Coinbase CDP: https://docs.cdp.coinbase.com/embedded-wallets/authentication-methods , https://docs.cdp.coinbase.com/embedded-wallets/welcome , https://docs.cdp.coinbase.com/embedded-wallets/pricing
- Dynamic: https://www.dynamic.xyz/docs/embedded-wallets/chains/overview.md , https://www.dynamic.xyz/docs/javascript/authentication-methods/mfa/passkey , https://www.dynamic.xyz/pricing
- Magic: https://magic.link/docs/authentication/login/webauthn , https://magic.link/pricing (via search result, not opened)
- Web3Auth: https://blog.web3auth.io/passkeys-authentication-factor/ , https://metamask.io/developer/embedded-wallets (via search result, not opened)
- Swig: https://build.onswig.com/llms.txt , https://build.onswig.com/examples/passkeys.md , https://build.onswig.com/evm/index.md
- Phantom: https://docs.phantom.com/phantom-connect , https://github.com/solana-foundation/templates/issues/468
- Robinhood Chain: https://docs.robinhood.com/chain/account-abstraction/ , https://chainid.network/chains_mini.json
