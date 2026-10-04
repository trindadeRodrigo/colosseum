'use client';
import { type BasketTx, type ChainId, explorerLink } from '@colosseum/schemas';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { formatUnits, parseTransaction, recoverTransactionAddress, verifyMessage } from 'viem';
import { base58Decode, base64Decode, parseSolanaTx } from '../bytes';
import { publicWalletEnv, type WalletChain, type WalletChains, walletChains } from '../chains';
import type { WebWalletPort } from '../port';
import { SignIn } from '../SignIn';
import { failureSentence, shortAddress } from '../view';
import { useApiFetch, useWalletPort } from '../WalletProvider';
import { DEV_PAGE_MARKER } from './marker';
import { evmRpc, type Reading, solanaRpc } from './rpc';
import { evmSelfTransfer, solanaSelfTransfer } from './self-transfer';

const CHAINS: ChainId[] = ['solana', 'robinhood'];
const MESSAGE = 'Tenonfi wallet check. This signature moves nothing.';
const button = 'rounded-[2px] border border-gray-500 px-3 py-1.5 text-sm hover:border-black';

/** Where a figure came from, when and how. Every figure on this page is followed by one. */
function Source({ of }: { of: Pick<Reading<unknown>, 'source' | 'fetchedAt' | 'method'> }) {
  return (
    <span className="font-mono text-xs text-gray-600">
      {of.source} · {of.fetchedAt} · {of.method}
    </span>
  );
}

/** A test network is said in words beside everything that comes from one. */
function NetworkLabel({ chain }: { chain: WalletChain }) {
  return chain.provenance === 'sandbox' ? (
    <span className="border border-gray-500 px-1.5 text-xs">test network</span>
  ) : (
    <span className="border border-black px-1.5 text-xs font-semibold">mainnet</span>
  );
}

type Step = { busy: string | null; done: ReactNode; problem: string | null };
const IDLE: Step = { busy: null, done: null, problem: null };

/** A button that changes its label while it works, then shows what happened in words. */
function useStep(): [Step, (label: string, run: () => Promise<ReactNode>) => Promise<void>] {
  const [step, setStep] = useState<Step>(IDLE);
  const run = useCallback(async (label: string, action: () => Promise<ReactNode>) => {
    setStep({ busy: label, done: null, problem: null });
    try {
      setStep({ busy: null, done: await action(), problem: null });
    } catch (e) {
      // The port throws WalletErrors; the RPC reads and the builders on this page throw plain ones.
      setStep({ busy: null, done: null, problem: failureSentence(e) ?? 'You declined.' });
    }
  }, []);
  return [step, run];
}

function Result({ step }: { step: Step }) {
  return (
    <div aria-live="polite" className="text-sm">
      {step.done}
      {step.problem && <p>{step.problem}</p>}
    </div>
  );
}

async function verifySolanaMessage(address: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    base58Decode(address) as BufferSource,
    'Ed25519',
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'Ed25519',
    key,
    base58Decode(signature) as BufferSource,
    new TextEncoder().encode(MESSAGE),
  );
}

function ChainPanel({
  port,
  chains,
  id,
}: {
  port: WebWalletPort;
  chains: WalletChains;
  id: ChainId;
}) {
  const chain = chains[id];
  const { family, name, networkName } = chain.config;
  const account = port.active(family);
  const address = account?.address ?? null;
  const caps = port.caps(id);
  const [balance, setBalance] = useState<Reading<bigint> | null>(null);
  const [balanceStep, runBalance] = useStep();
  const [messageStep, runMessage] = useStep();
  const [sendStep, runSend] = useStep();

  const readBalance = useCallback(
    (owner: string) =>
      runBalance('Reading the balance…', async () => {
        const rpc = family === 'solana' ? solanaRpc(chain) : evmRpc(chain);
        setBalance(await rpc.balance(owner));
        return null;
      }),
    [chain, family, runBalance],
  );
  useEffect(() => {
    setBalance(null);
    if (address) void readBalance(address);
  }, [address, readBalance]);

  if (!account || !address)
    return (
      <section className="border border-gray-300 p-4">
        <h2 className="font-semibold">
          {name} <NetworkLabel chain={chain} />
        </h2>
        <p className="mt-2 text-sm">
          No {family === 'solana' ? 'Solana' : 'EVM'} wallet is connected. A person who signs in
          with an outside wallet of one family has no account in the other.
        </p>
      </section>
    );

  const unit = family === 'solana' ? 'lamport' : 'wei';
  const sendLabel = `Sign and send: 1 ${unit} to yourself on ${networkName}`;
  const canSend = chain.provenance === 'sandbox';

  const signMessage = () =>
    runMessage('Waiting for the signature…', async () => {
      const signature = await port.signMessage(family, MESSAGE);
      const valid =
        family === 'solana'
          ? await verifySolanaMessage(address, signature)
          : await verifyMessage({
              address: address as `0x${string}`,
              message: MESSAGE,
              signature: signature as `0x${string}`,
            });
      return (
        <p>
          {valid
            ? 'Signed, and the signature is valid for'
            : 'Signed, but the signature is not valid for'}{' '}
          <span className="font-mono">{shortAddress(address)}</span>.{' '}
          <span className="break-all font-mono text-xs">{signature}</span>
        </p>
      );
    });

  const send = () =>
    runSend('Building, signing and sending…', async () => {
      const tx: BasketTx =
        family === 'solana'
          ? await solanaSelfTransfer(chain, address)
          : await evmSelfTransfer(chain, address);
      let txId: string;
      let signedBy: string;
      if (family === 'solana') {
        const [signed] = await port.sign(id, [tx]);
        if (!signed) throw new Error('the wallet returned nothing');
        signedBy = parseSolanaTx(base64Decode(signed)).feePayer;
        txId = await solanaRpc(chain).send(signed);
      } else if (caps.signOnly) {
        const [signed] = await port.sign(id, [tx]);
        if (!signed) throw new Error('the wallet returned nothing');
        const raw = signed as `0x02${string}`;
        signedBy = `${await recoverTransactionAddress({ serializedTransaction: raw })} (chain ${parseTransaction(raw).chainId})`;
        txId = await evmRpc(chain).send(signed);
      } else {
        signedBy = 'the outside wallet, which sent it itself';
        txId = (await port.send(id, tx)).txId;
      }
      const link = explorerLink(chain.config, txId);
      void readBalance(address);
      return (
        <p>
          Sent on {networkName}. Signed by <span className="font-mono">{signedBy}</span>.{' '}
          <span className="break-all font-mono text-xs">{txId}</span>{' '}
          {link && (
            <a className="font-mono underline" href={link} target="_blank" rel="noreferrer">
              Tx ↗
            </a>
          )}
        </p>
      );
    });

  const funded = balance !== null && balance.value > 0n;
  return (
    <section className="space-y-3 border border-gray-300 p-4">
      <h2 className="font-semibold">
        {name} <NetworkLabel chain={chain} />
      </h2>
      <dl className="space-y-1 text-sm">
        <div>
          <dt className="inline text-gray-600">Network: </dt>
          <dd className="inline">
            {networkName}
            {chain.config.evmChainId !== null && `, chain id ${chain.config.evmChainId}`}
          </dd>
        </div>
        <div>
          <dt className="inline text-gray-600">Address: </dt>
          <dd className="inline break-all font-mono">{address}</dd>{' '}
          <span>
            ({account.kind === 'embedded' ? 'made at sign-in' : 'an outside wallet'}
            {port.test && ', throwaway keys'})
          </span>
        </div>
        <div>
          <dt className="inline text-gray-600">Gas balance: </dt>
          <dd className="inline">
            {balance ? (
              <>
                <span className="font-mono tabular-nums">
                  {formatUnits(balance.value, chain.gas.decimals)} {chain.gas.symbol}
                </span>{' '}
                <NetworkLabel chain={chain} /> <Source of={balance} />
              </>
            ) : (
              (balanceStep.busy ?? 'not read')
            )}
          </dd>
        </div>
        <div>
          <dt className="inline text-gray-600">Funding: </dt>
          <dd className="inline">
            {balance === null
              ? 'not known until the balance is read'
              : funded
                ? '■ Funded for the network fee'
                : `□ Not funded: send test ${chain.gas.symbol} to this address from a faucet`}
          </dd>
        </div>
        <div>
          <dt className="inline text-gray-600">This wallet: </dt>
          <dd className="inline">
            {caps.silent ? 'signs with no prompt' : 'prompts for each signature'},{' '}
            {caps.signOnly ? 'hands the signed bytes back' : 'sends what it signs itself'},{' '}
            {caps.batchSign} at a time
          </dd>
        </div>
      </dl>
      {balanceStep.problem && <p className="text-sm">{balanceStep.problem}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          aria-busy={balanceStep.busy !== null}
          onClick={() => balanceStep.busy || readBalance(address)}
        >
          {balanceStep.busy ?? 'Read the balance again'}
        </button>
        <button
          type="button"
          className={button}
          aria-busy={messageStep.busy !== null}
          onClick={() => messageStep.busy || signMessage()}
        >
          {messageStep.busy ?? 'Sign a message'}
        </button>
        <button
          type="button"
          className={button}
          aria-busy={sendStep.busy !== null}
          aria-disabled={!canSend}
          onClick={() => (canSend && !sendStep.busy ? send() : undefined)}
        >
          {sendStep.busy ?? sendLabel}
        </button>
      </div>
      {!canSend && (
        <p className="text-sm">
          This page sends on a test network only, and this chain is on mainnet.
        </p>
      )}
      <Result step={messageStep} />
      <Result step={sendStep} />
    </section>
  );
}

/** What is in a token, read without checking it: the API is what verifies it. */
function claims(token: string): Record<string, unknown> {
  const body = token.split('.')[1] ?? '';
  const padded = body
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(body.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(base64Decode(padded))) as Record<string, unknown>;
}

function Tokens({ port }: { port: WebWalletPort }) {
  const [step, run] = useStep();
  const apiFetch = useApiFetch();
  const [apiStep, runApi] = useStep();
  const read = () =>
    run('Asking for the token…', async () => {
      const headers = await port.authHeaders();
      const access = headers.authorization?.replace(/^Bearer /, '');
      if (!access) return <p>This wallet has no token: its calls reach the API with no sign-in.</p>;
      const c = claims(access);
      const expires = typeof c.exp === 'number' ? new Date(c.exp * 1000).toISOString() : 'unknown';
      return (
        <ul className="font-mono text-xs">
          <li>headers sent: {Object.keys(headers).join(', ')}</li>
          <li>
            access token: {access.slice(0, 12)}… ({access.length} characters)
          </li>
          <li>issuer: {String(c.iss)}</li>
          <li>audience (the Privy app id): {String(c.aud)}</li>
          <li>subject (the user id): {String(c.sub)}</li>
          <li>expires: {expires}</li>
        </ul>
      );
    });
  const callApi = () =>
    runApi('Calling the API…', async () => {
      const res = await apiFetch('/v1/config');
      return <p>GET /v1/config answered {res.status} with the sign-in headers attached.</p>;
    });
  return (
    <section className="space-y-3 border border-gray-300 p-4">
      <h2 className="font-semibold">Sign-in token for the API</h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} aria-busy={step.busy !== null} onClick={read}>
          {step.busy ?? 'Show what the API receives'}
        </button>
        <button
          type="button"
          className={button}
          aria-busy={apiStep.busy !== null}
          onClick={callApi}
        >
          {apiStep.busy ?? 'Call the API with it'}
        </button>
      </div>
      <Result step={step} />
      <Result step={apiStep} />
    </section>
  );
}

export function DevWallet() {
  const port = useWalletPort();
  // A value this cannot read stops sign-in, and the sign-in control says which variable it is.
  const chains = useMemo(() => {
    try {
      return walletChains(publicWalletEnv());
    } catch {
      return null;
    }
  }, []);
  return (
    <div className="space-y-6" data-marker={DEV_PAGE_MARKER}>
      <div>
        <h1 className="text-2xl font-semibold">Wallet check</h1>
        <p className="mt-1 text-sm text-gray-600">
          A development page, not part of the product. It exists under the development server only.
          Nothing here is sent unless you press a button that says so.
        </p>
      </div>
      {/* Signed out, the product's own sign-in. Signed in, "Sign out" is in the bar above. */}
      {port.status !== 'ready' && <SignIn />}
      {port.status === 'ready' && chains && (
        <>
          <p className="font-mono text-xs">user id: {port.userId}</p>
          {CHAINS.map((id) => (
            <ChainPanel key={id} port={port} chains={chains} id={id} />
          ))}
          <Tokens port={port} />
        </>
      )}
    </div>
  );
}
