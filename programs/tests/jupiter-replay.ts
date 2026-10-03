import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccountMeta,
  AccountRole,
  type Address,
  address,
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getInitializeMint2Instruction } from '@solana-program/token-2022';
import {
  assetsAddress,
  configAddress,
  createVaultInstruction,
  DEFAULT_PARAMS,
  depositInstruction,
  ERR,
  initAssetsInstruction,
  initConfigInstruction,
  ownerSwapInstruction,
  upsertAssetInstruction,
  vaultAddress,
} from './src/basket';
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM,
  BASKET_PROGRAM,
  MAX_TRANSACTION_BYTES,
  REPO_ROOT,
  SYSTEM_PROGRAM,
} from './src/env';
import {
  createAtaInstruction,
  type TestMint,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from './src/tokens';
import { type LocalRpc, type Sent, sendAndWait, waitUntilUp } from './src/validator';

// The owner's swap with a real route: Jupiter's own instruction bytes and account list, run by
// Jupiter's own program against a real pool, on a validator that never leaves this machine.
//
//   pnpm exec tsx programs/tests/jupiter-replay.ts freeze
//       Asks Jupiter for one route (the dollar token to the stock token, one pool) and reads the
//       accounts it names from mainnet. Read-only. Writes fixtures/solana-vault/jupiter-route.json.
//
//   pnpm exec tsx programs/tests/jupiter-replay.ts replay <dir> <rpc port>
//       Starts a local validator with the vault program, the programs of the route cloned from
//       mainnet (read-only) and the frozen accounts, then sends real transactions to it: a vault
//       buys the stock token through `owner_swap`, the same route is tried with the output sent to
//       someone else (hostile case A1), and create-and-buy is measured at 7 and 12 targets.
//       Prints a report and writes <dir>/report.json.
//
// Every key is made here, lives in this process only, and holds nothing outside this validator.
// The route was asked for one address and is replayed for another: the vault of the replay takes
// the place of the taker, and its token accounts the place of the taker's, wherever they appear.

const JUPITER_API = process.env.JUPITER_API ?? 'https://api.jup.ag/swap/v2';
const MAINNET_RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const FIXTURE = join(REPO_ROOT, 'fixtures', 'solana-vault', 'jupiter-route.json');

/** The real route this replays: USDC into SPYx, the first stock token of the launch shelf. */
const INPUT_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const OUTPUT_MINT = address('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W');
/** 10 units of the dollar token. */
const AMOUNT = 10_000000n;
/** One pool with plain maths, so a snapshot of its accounts is enough to run it again. */
const DEXES = 'Raydium CLMM';
/** Any address: the route is asked for it and replayed for another. */
const TAKER = address('5ryENEfMqBh4VYcmZ2rxQeAphUYin1P2MiB8s4Yy3AEF');

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** What a test validator already has. */
const BUILT_IN = new Set<string>([
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  'ComputeBudget111111111111111111111111111111',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EGPRxuBQNq2F',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
]);

type RouteAccount = { pubkey: Address; isSigner: boolean; isWritable: boolean };
type FrozenAccount = { address: Address; owner: Address; lamports: string; data: string };
type RouteFixture = {
  provenance: 'fixture';
  about: string;
  source: string;
  method: string;
  fetchedAt: string;
  /** The mainnet slot the accounts were read at. */
  slot: string;
  taker: Address;
  inputMint: Address;
  outputMint: Address;
  takerInput: Address;
  takerOutput: Address;
  quote: {
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    route: string[];
  };
  instruction: { programId: Address; accounts: RouteAccount[]; data: string };
  lookupTables: Record<Address, Address[]>;
  /** Programs of the route. Cloned from mainnet when the replay starts; their code is not kept here. */
  programs: Address[];
  /** Every other account the route names, as it was at `slot`. */
  accounts: FrozenAccount[];
};

const addressEncoder = getAddressEncoder();

async function ataOf(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  return pda;
}

// ---- freeze ----

async function freeze(): Promise<void> {
  const query = new URLSearchParams({
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    amount: AMOUNT.toString(),
    taker: TAKER,
    slippageBps: '100',
    dexes: DEXES,
    maxAccounts: '30',
  });
  const source = `${JUPITER_API}/build?${query}`;
  const answer = await fetch(source);
  if (!answer.ok) throw new Error(`Jupiter answered ${answer.status}: the route cannot be frozen`);
  const build = (await answer.json()) as {
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    routePlan: { swapInfo: { label: string; inputMint: string; outputMint: string } }[];
    swapInstruction: RouteFixture['instruction'];
    addressesByLookupTableAddress: Record<Address, Address[]>;
  };
  const instruction = build.swapInstruction;
  if (!instruction?.accounts?.length) throw new Error('Jupiter returned no swap instruction');
  for (const step of build.routePlan)
    if (step.swapInfo.inputMint !== INPUT_MINT || step.swapInfo.outputMint !== OUTPUT_MINT)
      throw new Error('the route goes through another token: ask for a direct one');

  const mainnet = createSolanaRpc(MAINNET_RPC);
  const wanted = [
    ...new Set<Address>([
      INPUT_MINT,
      OUTPUT_MINT,
      instruction.programId,
      ...instruction.accounts.map((a) => a.pubkey),
      ...(Object.keys(build.addressesByLookupTableAddress) as Address[]),
    ]),
  ].filter((key) => !BUILT_IN.has(key) && !key.startsWith('Sysvar') && key !== TAKER);
  const { context, value } = await mainnet
    .getMultipleAccounts(wanted, { encoding: 'base64', commitment: 'confirmed' })
    .send();

  const owners = new Map<Address, Address>();
  const programs: Address[] = [];
  const accounts: FrozenAccount[] = [];
  for (const [i, key] of wanted.entries()) {
    const found = value[i];
    // An address the route names that holds nothing, such as a program's event authority.
    if (!found) continue;
    owners.set(key, found.owner);
    if (found.executable && found.owner === UPGRADEABLE_LOADER) programs.push(key);
    else if (found.executable) throw new Error(`${key} is a program this script cannot clone`);
    else
      accounts.push({
        address: key,
        owner: found.owner,
        lamports: found.lamports.toString(),
        data: found.data[0],
      });
  }
  const programOf = (mint: Address) =>
    owners.get(mint) ??
    (() => {
      throw new Error(`no mint at ${mint}`);
    })();
  const takerInput = await ataOf(TAKER, INPUT_MINT, programOf(INPUT_MINT));
  const takerOutput = await ataOf(TAKER, OUTPUT_MINT, programOf(OUTPUT_MINT));
  const named = new Set(instruction.accounts.map((a) => a.pubkey));
  if (!named.has(TAKER) || !named.has(takerInput) || !named.has(takerOutput))
    throw new Error("the route does not name the taker and the taker's two token accounts");

  const fixture: RouteFixture = {
    provenance: 'fixture',
    about:
      'One Jupiter route and the mainnet accounts it names, frozen for programs/tests/jupiter-replay.ts. The amounts are what Jupiter quoted at that moment. Not a price to show anyone.',
    source,
    method:
      'GET /swap/v2/build for a placeholder taker; then getMultipleAccounts on mainnet for every account of the swap instruction, its lookup tables and both mints, at one confirmed slot',
    fetchedAt: new Date().toISOString(),
    slot: context.slot.toString(),
    taker: TAKER,
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    // The taker's own token accounts hold nothing and are not kept: the replay's vault has its own.
    takerInput,
    takerOutput,
    quote: {
      inAmount: build.inAmount,
      outAmount: build.outAmount,
      otherAmountThreshold: build.otherAmountThreshold,
      slippageBps: build.slippageBps,
      route: build.routePlan.map((step) => step.swapInfo.label),
    },
    instruction,
    lookupTables: build.addressesByLookupTableAddress,
    programs,
    accounts: accounts.filter((a) => a.address !== takerInput && a.address !== takerOutput),
  };
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  // Written the way the linter wants a JSON file, so the commit that carries it passes.
  execFileSync('pnpm', ['exec', 'biome', 'format', '--write', FIXTURE], { cwd: REPO_ROOT });
  console.log(
    JSON.stringify(
      {
        wrote: FIXTURE,
        slot: fixture.slot,
        route: fixture.quote.route,
        selector: Buffer.from(instruction.data, 'base64').subarray(0, 8).toString('hex'),
        instructionAccounts: instruction.accounts.length,
        programs,
        accountsKept: fixture.accounts.length,
        bytesKept: fixture.accounts.reduce((n, a) => n + Buffer.from(a.data, 'base64').length, 0),
        quote: fixture.quote,
      },
      null,
      2,
    ),
  );
}

// ---- replay ----

/** A file the validator loads an account from at start. */
function accountFile(
  dir: string,
  account: { address: Address; owner: Address; lamports: string | number; data: Uint8Array },
): string[] {
  const file = join(dir, 'accounts', `${account.address}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      pubkey: account.address,
      account: {
        lamports: Number(account.lamports),
        data: [Buffer.from(account.data).toString('base64'), 'base64'],
        owner: account.owner,
        executable: false,
        rentEpoch: 0,
        space: account.data.length,
      },
    }),
  );
  return ['--account', account.address, file];
}

/** A token account of the classic program, written straight into the validator: local money. */
function tokenAccountBytes(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  data.set(addressEncoder.encode(mint), 0);
  data.set(addressEncoder.encode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1; // initialised
  return data;
}

/** An address lookup table holding these addresses: a 56-byte header, then the addresses. */
function lookupTableBytes(addresses: Address[]): Uint8Array {
  const data = new Uint8Array(56 + 32 * addresses.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
  for (const [i, entry] of addresses.entries()) data.set(addressEncoder.encode(entry), 56 + 32 * i);
  return data;
}

type TokenState = { owner: Address; amount: bigint; delegate: boolean; closeAuthority: boolean };

async function tokenState(rpc: LocalRpc, token: Address): Promise<TokenState | null> {
  const { value } = await rpc.getAccountInfo(token, { encoding: 'base64' }).send();
  if (!value) return null;
  const data = new Uint8Array(Buffer.from(value.data[0], 'base64'));
  const view = new DataView(data.buffer);
  return {
    owner: getAddressDecoder().decode(data.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
    delegate: view.getUint32(72, true) !== 0,
    closeAuthority: view.getUint32(129, true) !== 0,
  };
}

/** Compute units and the deepest call of a landed transaction, from its own record. */
async function executionOf(rpc: LocalRpc, signature: string) {
  const tx = await rpc
    .getTransaction(signature as never, {
      commitment: 'confirmed',
      encoding: 'json',
      maxSupportedTransactionVersion: 0,
    })
    .send();
  const logs = tx?.meta?.logMessages ?? [];
  const depths = logs.map((l) => Number(l.match(/^Program \w+ invoke \[(\d+)\]/)?.[1] ?? 0));
  return {
    computeUnits: Number(tx?.meta?.computeUnitsConsumed ?? 0),
    deepestCall: Math.max(0, ...depths),
    accounts:
      (tx?.transaction.message.accountKeys.length ?? 0) +
      (tx?.meta?.loadedAddresses?.writable.length ?? 0) +
      (tx?.meta?.loadedAddresses?.readonly.length ?? 0),
    swapLog: logs.find((l) => l.includes('owner swap:')) ?? null,
  };
}

async function replay(dir: string, port: number): Promise<void> {
  if (!existsSync(FIXTURE)) throw new Error('no frozen route: run `jupiter-replay.ts freeze`');
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RouteFixture;
  if (!existsSync(join(REPO_ROOT, 'target', 'deploy', 'basket.so')))
    throw new Error('target/deploy/basket.so is not built: see programs/README.md');
  mkdirSync(join(dir, 'accounts'), { recursive: true });
  const rpc = createSolanaRpc(`http://127.0.0.1:${port}`);

  const [deployer, owner, attacker] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const programOf = (mint: Address): Address => {
    const found = fixture.accounts.find((a) => a.address === mint);
    if (!found) throw new Error(`the fixture has no mint ${mint}`);
    return found.owner;
  };
  const decimalsOf = (mint: Address): number => {
    const found = fixture.accounts.find((a) => a.address === mint);
    return Buffer.from(found?.data ?? '', 'base64')[44] ?? 0;
  };
  const stand = (mint: Address): TestMint => ({
    address: mint,
    program: programOf(mint),
    decimals: decimalsOf(mint),
    issuer: deployer, // never used: the real issuer is not here, and nothing is minted
  });
  const cash = stand(fixture.inputMint);
  const stock = stand(fixture.outputMint);
  if (cash.program !== TOKEN_PROGRAM) throw new Error('the made-up cash account is a classic one');

  // What every transaction of the vault names, in a table of the platform's own.
  const platformTable = (await generateKeyPairSigner()).address;
  const platformAddresses = [
    BASKET_PROGRAM,
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    await configAddress(),
    await assetsAddress(),
    cash.address,
    stock.address,
  ];
  const tables: Record<Address, Address[]> = {
    ...fixture.lookupTables,
    [platformTable]: platformAddresses,
  };

  const ownerCash = await ataOf(owner.address, cash.address, cash.program);
  const loaded = [
    ...fixture.accounts.flatMap((a) =>
      accountFile(dir, { ...a, data: new Uint8Array(Buffer.from(a.data, 'base64')) }),
    ),
    // 1,000 units of the dollar token for the owner. It exists on this validator only.
    ...accountFile(dir, {
      address: ownerCash,
      owner: TOKEN_PROGRAM,
      lamports: 2_039_280,
      data: tokenAccountBytes(cash.address, owner.address, 1_000_000000n),
    }),
    ...accountFile(dir, {
      address: platformTable,
      owner: ADDRESS_LOOKUP_TABLE_PROGRAM,
      lamports: 10_000_000,
      data: lookupTableBytes(platformAddresses),
    }),
  ];

  const validator = spawn(
    'solana-test-validator',
    [
      ...['--ledger', join(dir, 'ledger'), '--reset', '--quiet'],
      ...['--bind-address', '127.0.0.1', '--rpc-port', String(port)],
      ...['--faucet-port', String(port + 2), '--gossip-port', String(port + 3)],
      ...['--dynamic-port-range', `${port + 10}-${port + 40}`],
      ...['--mint', deployer.address],
      // Read-only: the programs of the route are fetched from mainnet, at the slot of the snapshot.
      ...['--url', MAINNET_RPC, '--warp-slot', fixture.slot],
      ...fixture.programs.flatMap((program) => ['--clone-upgradeable-program', program]),
      ...[
        '--upgradeable-program',
        BASKET_PROGRAM,
        join(REPO_ROOT, 'target', 'deploy', 'basket.so'),
        deployer.address,
      ],
      ...loaded,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const stop = () => {
    validator.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    await waitUntilUp(rpc, validator);
    const must = async (payer: KeyPairSigner, instructions: Instruction[], what: string) => {
      const sent = await sendAndWait(rpc, payer, instructions, { tables });
      if (sent.failed) throw new Error(`${what} failed: ${JSON.stringify(sent.err, bigintSafe)}`);
      return sent;
    };

    // The platform, as a deploy would set it: the router is the program of the frozen route.
    await must(
      deployer,
      [
        getTransferSolInstruction({
          source: deployer,
          destination: owner.address,
          amount: 5_000_000_000n,
        }),
        getTransferSolInstruction({
          source: deployer,
          destination: attacker.address,
          amount: 1_000_000_000n,
        }),
        await initConfigInstruction(deployer, {
          guardian: deployer.address,
          defaultKeeper: deployer.address,
          routerProgram: fixture.instruction.programId,
          priceOwner: deployer.address,
          cashMint: cash.address,
          params: DEFAULT_PARAMS,
        }),
        await initAssetsInstruction(deployer),
        await upsertAssetInstruction(deployer, stock.address),
      ],
      'the platform setup',
    );

    // Eleven more listed mints, so a vault can name twelve targets. They hold no tokens.
    const others: Address[] = [];
    const rent = await rpc.getMinimumBalanceForRentExemption(82n).send();
    for (let i = 0; i < 11; i++) {
      const mint = await generateKeyPairSigner();
      await must(
        deployer,
        [
          getCreateAccountInstruction({
            payer: deployer,
            newAccount: mint,
            lamports: rent,
            space: 82n,
            programAddress: TOKEN_PROGRAM,
          }),
          getInitializeMint2Instruction(
            { mint: mint.address, decimals: 8, mintAuthority: deployer.address },
            { programAddress: TOKEN_PROGRAM },
          ),
          await upsertAssetInstruction(deployer, mint.address),
        ],
        'listing a mint',
      );
      others.push(mint.address);
    }

    /** Jupiter's instruction for this vault: the frozen bytes, with the vault in the taker's place. */
    const routeFor = async (vault: Address, output?: Address) => {
      const mine = new Map<Address, Address>([
        [fixture.taker, vault],
        [fixture.takerInput, await ataOf(vault, cash.address, cash.program)],
        [fixture.takerOutput, output ?? (await ataOf(vault, stock.address, stock.program))],
      ]);
      const routerAccounts: AccountMeta[] = fixture.instruction.accounts.map((a) => ({
        address: mine.get(a.pubkey) ?? a.pubkey,
        role: a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
      }));
      return {
        router: fixture.instruction.programId,
        data: new Uint8Array(Buffer.from(fixture.instruction.data, 'base64')),
        routerAccounts,
      };
    };
    const swapFor = async (vault: Address, output?: Address) =>
      ownerSwapInstruction({
        owner,
        vault,
        inputMint: cash,
        outputMint: stock,
        maxIn: BigInt(fixture.quote.inAmount),
        minOut: BigInt(fixture.quote.otherAmountThreshold),
        ...(await routeFor(vault, output)),
      });
    const weights = (count: number) =>
      [stock.address, ...others].slice(0, count).map((mint, i) => {
        const each = Math.floor(10_000 / count / 50) * 50;
        return { mint, targetBps: i === 0 ? 10_000 - each * (count - 1) : each };
      });
    const createFor = async (basketId: bigint, targets: number) => {
      const vault = await vaultAddress(owner.address, basketId);
      return [
        await createVaultInstruction({ owner, basketId, targets: weights(targets) }),
        await createAtaInstruction(owner, vault, cash),
        await depositInstruction({ owner, vault, mint: cash, amount: 20_000000n }),
      ];
    };

    // 1. A vault buys the stock token through the real route.
    const vault = await vaultAddress(owner.address, 1n);
    const vaultCash = await ataOf(vault, cash.address, cash.program);
    const vaultStock = await ataOf(vault, stock.address, stock.program);
    await must(owner, await createFor(1n, 1), 'create and deposit');
    const before = await tokenState(rpc, vaultCash);
    const bought = await must(
      owner,
      [await createAtaInstruction(owner, vault, stock), await swapFor(vault)],
      'the swap through the real route',
    );
    const [cashAfter, stockAfter] = [
      await tokenState(rpc, vaultCash),
      await tokenState(rpc, vaultStock),
    ];
    if (!before || !cashAfter || !stockAfter) throw new Error('a vault token account is missing');
    const spent = before.amount - cashAfter.amount;
    const received = stockAfter.amount;
    if (spent !== BigInt(fixture.quote.inAmount)) throw new Error(`the vault spent ${spent}`);
    if (received < BigInt(fixture.quote.otherAmountThreshold))
      throw new Error(`the vault received ${received}`);
    // Hostile case A11 on the real account list: nothing is left on either account.
    for (const state of [cashAfter, stockAfter])
      if (state.owner !== vault || state.delegate || state.closeAuthority)
        throw new Error('the route left a delegate, a close authority or another owner behind');

    // 2. Hostile case A1 on the real account list: the same route, paid to someone else. The
    // router is satisfied and would pay the attacker; the vault counts its own account.
    const attackerStock = await ataOf(attacker.address, stock.address, stock.program);
    await must(attacker, [await createAtaInstruction(attacker, attacker.address, stock)], 'setup');
    const diverted: Sent = await sendAndWait(rpc, owner, [await swapFor(vault, attackerStock)], {
      tables,
      skipPreflight: true,
    });
    const code = JSON.stringify(diverted.err, bigintSafe);
    if (!diverted.failed || !code.includes(String(ERR.ReceivedTooLittle)))
      throw new Error(`a route paid to someone else was not refused as expected: ${code}`);
    const unchanged = await tokenState(rpc, vaultCash);
    const attackerGot = (await tokenState(rpc, attackerStock))?.amount ?? 0n;
    if (unchanged?.amount !== cashAfter.amount || attackerGot !== 0n)
      throw new Error('the refused route moved tokens');

    // 3. Create, deposit and the first buy in one transaction, at 7 and at 12 targets.
    const sizes = [];
    for (const [basketId, targets] of [
      [7n, 7],
      [12n, 12],
    ] as const) {
      const target = await vaultAddress(owner.address, basketId);
      const instructions = [
        ...(await createFor(basketId, targets)),
        await createAtaInstruction(owner, target, stock),
        await swapFor(target),
      ];
      const sent = await sendAndWait(rpc, owner, instructions, { tables }).catch((e: unknown) => ({
        refused: e instanceof Error ? e.message.slice(0, 200) : String(e),
      }));
      sizes.push(
        'refused' in sent
          ? { targets, landed: false, ...sent }
          : {
              targets,
              landed: !sent.failed,
              bytes: sent.bytes,
              fits: sent.bytes <= MAX_TRANSACTION_BYTES,
              ...(await executionOf(rpc, sent.signature)),
            },
      );
    }

    const report = {
      route: {
        fetchedAt: fixture.fetchedAt,
        slot: fixture.slot,
        venue: fixture.quote.route,
        selector: Buffer.from(fixture.instruction.data, 'base64').subarray(0, 8).toString('hex'),
        instructionAccounts: fixture.instruction.accounts.length,
        programsCloned: fixture.programs,
        quote: fixture.quote,
      },
      swap: {
        bytes: bought.bytes,
        ...(await executionOf(rpc, bought.signature)),
        spent: spent.toString(),
        received: received.toString(),
        a11: {
          input: { ...cashAfter, amount: undefined },
          output: { ...stockAfter, amount: undefined },
        },
      },
      a1: {
        refusedWith: 'ReceivedTooLittle',
        err: diverted.err,
        attackerGot: attackerGot.toString(),
      },
      createAndFirstBuy: sizes,
    };
    writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, bigintSafe, 2)}\n`);
    console.log(JSON.stringify(report, bigintSafe, 2));
  } finally {
    stop();
  }
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

const [mode, dirArg, portArg] = process.argv.slice(2);
const run =
  mode === 'freeze'
    ? freeze()
    : mode === 'replay' && dirArg && portArg
      ? replay(dirArg, Number(portArg))
      : Promise.reject(new Error('usage: jupiter-replay.ts freeze | replay <dir> <rpc port>'));
run.then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
