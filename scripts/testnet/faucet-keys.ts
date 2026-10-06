import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newEvmKey } from '@colosseum/chain-evm/server';
import { getAddressDecoder } from '@solana/kit';

// The test faucet's two wallets (gate TEST-FAUCET): one on Solana devnet, one on Robinhood Chain's test
// network. Each is a fresh key made here for the faucet alone: it holds a float of test tokens and gas,
// funded from the deployer by a person, and never an authority or a role. Written to a folder outside
// every checkout, never over a key already there; only the public addresses are printed.
//
//   pnpm exec tsx scripts/testnet/faucet-keys.ts [--out <dir>]
//
// <dir> defaults to `testnet-keys` beside the checkout. The server reads each key from a variable a
// person sets: TESTNET_FAUCET_SOLANA_KEY (the JSON array in the .json file), TESTNET_FAUCET_ROBINHOOD_KEY
// (the 0x key in the .key file).

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const at = argv.indexOf('--out');
const out = resolve(at >= 0 ? (argv[at + 1] ?? '') : join(REPO, '..', 'testnet-keys'));
if (!relative(REPO, out).startsWith('..'))
  throw new Error('the keys go outside the checkout: name a folder with --out');
mkdirSync(out, { recursive: true, mode: 0o700 });

const SOLANA = join(out, 'solana-devnet-faucet.json');
const EVM = join(out, 'robinhood-testnet-faucet.key');
const EVM_ADDRESS = join(out, 'robinhood-testnet-faucet.address');

/** A Solana keypair in solana-keygen's form, the seed then the public key, and its address. */
function solanaAddress(): string {
  if (existsSync(SOLANA)) {
    const bytes = Uint8Array.from(JSON.parse(readFileSync(SOLANA, 'utf8')) as number[]);
    return getAddressDecoder().decode(bytes.subarray(32, 64));
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  if (seed.length !== 32 || pub.length !== 32) throw new Error('the Solana key came out wrong');
  writeFileSync(SOLANA, JSON.stringify([...seed, ...pub]), { mode: 0o600, flag: 'wx' });
  return getAddressDecoder().decode(pub);
}

function evmAddress(): string {
  if (existsSync(EVM)) return readFileSync(EVM_ADDRESS, 'utf8').trim();
  const { key, address } = newEvmKey();
  writeFileSync(EVM, `${key}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(EVM_ADDRESS, `${address}\n`, { flag: 'wx' });
  return address;
}

console.log(`solana devnet faucet\t${solanaAddress()}`);
console.log(`robinhood testnet faucet\t${evmAddress()}`);
