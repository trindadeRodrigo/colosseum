// Generated from idl/basket.json by packages/sdk/scripts/gen-guard-tables.ts.
// Do not edit: run `pnpm --filter @colosseum/sdk tables`. tables.test.ts fails when this file and its source disagree.
import type { ProgramTable } from '../solana/table';

export const BASKET_PROGRAM: ProgramTable = {
  address: '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
  instructions: {
    accept_admin: {
      discriminator: [112, 42, 45, 90, 116, 181, 13, 170],
      accounts: [
        {
          name: 'pending_admin',
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
      args: [],
    },
    cancel_pending: {
      discriminator: [74, 87, 109, 242, 64, 192, 151, 71],
      accounts: [
        {
          name: 'signer',
          signer: true,
          writable: false,
          optional: false,
        },
        {
          name: 'recipe',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [],
    },
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
          name: 'config',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'assets',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'recipe',
          signer: false,
          writable: false,
          optional: true,
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
    init_assets: {
      discriminator: [194, 213, 246, 53, 30, 31, 17, 56],
      accounts: [
        {
          name: 'admin',
          signer: true,
          writable: true,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'assets',
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
      args: [],
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
          name: 'cash_mint',
          signer: false,
          writable: false,
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
    launch: {
      discriminator: [153, 241, 93, 225, 22, 69, 74, 61],
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
      args: [],
    },
    owner_swap: {
      discriminator: [12, 59, 193, 156, 47, 162, 240, 108],
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
          name: 'config',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'assets',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'input_mint',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'output_mint',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'vault_input',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'vault_output',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'input_token_program',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'output_token_program',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'router_program',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [
        {
          name: 'max_in',
          type: 'u64',
        },
        {
          name: 'min_out',
          type: 'u64',
        },
        {
          name: 'data',
          type: 'bytes',
        },
      ],
    },
    pause_keeper: {
      discriminator: [155, 213, 197, 244, 116, 255, 251, 45],
      accounts: [
        {
          name: 'guardian',
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
      args: [],
    },
    propose_admin: {
      discriminator: [121, 214, 199, 212, 87, 39, 117, 234],
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
          name: 'pending_admin',
          type: 'pubkey',
        },
      ],
    },
    publish_recipe: {
      discriminator: [209, 229, 198, 141, 172, 92, 229, 96],
      accounts: [
        {
          name: 'creator',
          signer: true,
          writable: true,
          optional: false,
        },
        {
          name: 'recipe',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'assets',
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
          name: 'family_id',
          type: {
            array: ['u8', 32],
          },
        },
        {
          name: 'components',
          type: {
            vec: {
              defined: 'Component',
            },
          },
        },
        {
          name: 'meta_hash',
          type: {
            array: ['u8', 32],
          },
        },
        {
          name: 'max_fee_bps',
          type: 'u16',
        },
        {
          name: 'flags',
          type: 'u8',
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
        {
          name: 'cash_mint',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [],
    },
    set_params: {
      discriminator: [27, 234, 178, 52, 147, 2, 187, 141],
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
          name: 'params',
          type: {
            defined: 'Params',
          },
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
    set_targets: {
      discriminator: [28, 232, 16, 206, 7, 118, 12, 122],
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
          name: 'config',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'assets',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [
        {
          name: 'targets',
          type: {
            vec: {
              defined: 'Target',
            },
          },
        },
      ],
    },
    unpause_keeper: {
      discriminator: [56, 105, 78, 54, 98, 63, 180, 224],
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
      args: [],
    },
    update_recipe: {
      discriminator: [79, 118, 143, 237, 68, 36, 242, 15],
      accounts: [
        {
          name: 'creator',
          signer: true,
          writable: false,
          optional: false,
        },
        {
          name: 'recipe',
          signer: false,
          writable: true,
          optional: false,
        },
        {
          name: 'config',
          signer: false,
          writable: false,
          optional: false,
        },
        {
          name: 'assets',
          signer: false,
          writable: false,
          optional: false,
        },
      ],
      args: [
        {
          name: 'components',
          type: {
            vec: {
              defined: 'Component',
            },
          },
        },
        {
          name: 'meta_hash',
          type: {
            array: ['u8', 32],
          },
        },
      ],
    },
    upsert_asset: {
      discriminator: [236, 173, 176, 44, 167, 62, 33, 253],
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
          writable: false,
          optional: false,
        },
        {
          name: 'assets',
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
      ],
      args: [
        {
          name: 'args',
          type: {
            defined: 'AssetArgs',
          },
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
    AssetArgs: [
      {
        name: 'price_slot',
        type: 'u8',
      },
      {
        name: 'price_index',
        type: 'u16',
      },
      {
        name: 'twap_index',
        type: 'u16',
      },
      {
        name: 'price_kind',
        type: 'u8',
      },
      {
        name: 'session',
        type: 'u8',
      },
      {
        name: 'max_weight_bps',
        type: 'u16',
      },
      {
        name: 'flags',
        type: 'u8',
      },
      {
        name: 'source_check',
        type: {
          array: ['u8', 32],
        },
      },
    ],
    Component: [
      {
        name: 'mint',
        type: 'pubkey',
      },
      {
        name: 'weight_bps',
        type: 'u16',
      },
    ],
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
