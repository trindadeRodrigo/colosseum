// Generated from idl/basket.json by packages/sdk/scripts/gen-guard-tables.ts.
// Do not edit: run `pnpm --filter @colosseum/sdk tables`. tables.test.ts fails when this file and its source disagree.
import type { ProgramTable } from '../solana/table';

export const BASKET_PROGRAM: ProgramTable = {
  address: '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
  instructions: {
    create_vault: {
      discriminator: [29, 237, 247, 208, 193, 82, 54, 135],
      accounts: [
        {
          name: 'owner',
          signer: true,
          writable: true,
          optional: false,
        },
        {
          name: 'vault',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'system_program',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [
        {
          name: 'basket_id',
          type: 'u64',
        },
        {
          name: 'targets',
          type: {
            vec: {
              defined: 'Target',
            },
          },
        },
        {
          name: 'auto_follow',
          type: 'bool',
        },
        {
          name: 'expected_version',
          type: 'u32',
        },
      ],
    },
    deposit: {
      discriminator: [242, 35, 198, 137, 82, 225, 242, 182],
      accounts: [
        {
          name: 'owner',
          signer: true,
          writable: false,
          optional: false,
        },
        {
          name: 'vault',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'mint',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'vault_token_account',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'source',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'token_program',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [
        {
          name: 'amount',
          type: 'u64',
        },
      ],
    },
    init_config: {
      discriminator: [23, 235, 115, 232, 168, 96, 1, 231],
      accounts: [
        {
          name: 'authority',
          signer: true,
          writable: true,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'program',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'program_data',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'system_program',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [
        {
          name: 'args',
          type: {
            defined: 'InitConfigArgs',
          },
        },
      ],
    },
    set_cash_mint: {
      discriminator: [27, 163, 236, 15, 62, 222, 172, 245],
      accounts: [
        {
          name: 'admin',
          signer: true,
          writable: false,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: true,
          optional: false,
        },
      ],
      args: [
        {
          name: 'cash_mint',
          type: 'pubkey',
        },
      ],
    },
    set_price_owner: {
      discriminator: [58, 135, 118, 146, 2, 200, 205, 39],
      accounts: [
        {
          name: 'admin',
          signer: true,
          writable: false,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: true,
          optional: false,
        },
      ],
      args: [
        {
          name: 'price_owner',
          type: 'pubkey',
        },
      ],
    },
    set_router: {
      discriminator: [236, 248, 107, 200, 151, 160, 44, 250],
      accounts: [
        {
          name: 'admin',
          signer: true,
          writable: false,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: true,
          optional: false,
        },
      ],
      args: [
        {
          name: 'router_program',
          type: 'pubkey',
        },
      ],
    },
    withdraw: {
      discriminator: [183, 18, 70, 156, 148, 109, 161, 34],
      accounts: [
        {
          name: 'owner',
          signer: true,
          writable: false,
          optional: false,
        },
        {
          name: 'vault',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'mint',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'vault_token_account',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'destination',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'token_program',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [
        {
          name: 'amount',
          type: 'u64',
        },
      ],
    },
  },
  types: {
    InitConfigArgs: [
      {
        name: 'guardian',
        type: 'pubkey',
      },
      {
        name: 'default_keeper',
        type: 'pubkey',
      },
      {
        name: 'router_program',
        type: 'pubkey',
      },
      {
        name: 'price_owner',
        type: 'pubkey',
      },
      {
        name: 'cash_mint',
        type: 'pubkey',
      },
      {
        name: 'params',
        type: {
          defined: 'Params',
        },
      },
    ],
    Params: [
      {
        name: 'tolerance_bps',
        type: 'u16',
      },
      {
        name: 'loss_cap_bps',
        type: 'u16',
      },
      {
        name: 'band_bps',
        type: 'u16',
      },
      {
        name: 'twap_dev_bps',
        type: 'u16',
      },
      {
        name: 'max_price_age_s',
        type: 'u16',
      },
      {
        name: 'asset_cooldown_s',
        type: 'u32',
      },
      {
        name: 'publish_delay_s',
        type: 'u32',
      },
      {
        name: 'session_open_utc_s',
        type: 'u32',
      },
      {
        name: 'session_close_utc_s',
        type: 'u32',
      },
    ],
    Target: [
      {
        name: 'mint',
        type: 'pubkey',
      },
      {
        name: 'target_bps',
        type: 'u16',
      },
    ],
  },
};
