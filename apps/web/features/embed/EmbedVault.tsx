'use client';
import { type ChainId, VaultResponse } from '@colosseum/schemas';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { Mark } from '../../components/shell/Mark';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { EmbedShell } from '../../components/ui/EmbedShell';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { useWaitPhase } from '../../components/ui/wait';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { API } from '../../lib/api';
import { tokenName } from '../order/amounts';
import { dollars, share } from '../portfolio/figures';
import {
  type PortfolioChain,
  positionValueSource,
  priceOf,
  vaultValueSource,
} from '../portfolio/portfolio';
import { apiUrl } from '../wallet/api-url';
import { PARTNER_BUTTON } from './EmbedGoal';
import { useHostHeight } from './host-height';

// A plan held in a vault, in the partner's skin (embed-shell.md, Anatomy): what it is worth, its parts
// with their weights, each value on its pin in the partner's muted colour, the quiet sample line
// where the chain is not live, the disclaimer, and the way to see it in tenonfi. Read from the public vault
// route (`GET /v1/vaults/{chain}/{address}`): anybody may read a vault, so nothing here needs a
// sign-in, and nothing is written or signed.

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'read'; answer: VaultResponse };

export function EmbedVault({
  chain,
  address,
  style,
}: {
  chain: ChainId;
  address: string;
  style: CSSProperties;
}) {
  const t = useT();
  const lang = useLang();
  const words = t.embed;
  const [state, setState] = useState<State>({ kind: 'loading' });
  useHostHeight();

  useEffect(() => {
    let live = true;
    fetch(apiUrl(API, `/v1/vaults/${chain}/${encodeURIComponent(address)}`), {
      cache: 'no-store',
      redirect: 'error',
    })
      .then(async (res) => (res.ok ? VaultResponse.safeParse(await res.json()) : null))
      .catch(() => null)
      .then((parsed) => {
        if (!live) return;
        setState(
          parsed?.success && parsed.data.chain === chain && parsed.data.vault.address === address
            ? { kind: 'read', answer: parsed.data }
            : { kind: 'unavailable' },
        );
      });
    return () => {
      live = false;
    };
  }, [chain, address]);

  // The hosted API may be asleep: after a few seconds the wait says so, and after a minute it is the
  // one sentence the shell has for a plan it cannot show.
  const phase = useWaitPhase(state.kind === 'loading');
  const labels = {
    loading: words.loading,
    slow: t.shell.wait.slow,
    unavailable: words.unavailable,
    showSchedule: words.showSchedule,
    poweredBy: words.poweredBy,
  };
  if (state.kind !== 'read')
    return (
      <div style={style} data-ui="embed-frame">
        {state.kind === 'loading' && phase !== 'over' ? (
          <EmbedShell
            label={words.label}
            lang={LOCALE[lang]}
            state="loading"
            slow={phase === 'slow'}
            labels={labels}
          />
        ) : (
          <EmbedShell label={words.label} lang={LOCALE[lang]} state="unavailable" labels={labels} />
        )}
      </div>
    );

  const { answer } = state;
  const { vault } = answer;
  // The portfolio's helpers read a chain's entry: this answer is one vault of one chain.
  const entry: PortfolioChain = {
    chain: answer.chain,
    name: answer.name,
    mode: answer.mode,
    provenance: answer.provenance,
    vaults: [vault],
    prices: answer.prices,
  };
  const parts = [...vault.positions].sort((a, b) => b.weightBps - a.weightBps);
  const page = `/vaults/${chain}/${encodeURIComponent(address)}`;
  return (
    <div style={style} data-ui="embed-frame">
      <EmbedShell
        label={words.label}
        lang={LOCALE[lang]}
        title={words.vault.title(answer.name)}
        lead={words.vault.lead}
        credit={{ name: 'tenonfi', href: page, symbol: <Mark size={16} mono /> }}
        labels={labels}
        sample={
          vault.provenance === 'live'
            ? undefined
            : {
                line:
                  vault.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
              }
        }
      >
        <dl>
          <div className="flex justify-between gap-[0.75em] py-[0.6em]">
            <dt className="text-muted-foreground">{words.vault.value}</dt>
            <dd>
              <ProvenancePin
                value={dollars(lang, vault.valueUsd)}
                obs={vaultValueSource(entry, vault, t.portfolio.vault.valueMethod)}
                labels={t.pin}
              />
            </dd>
          </div>
        </dl>
        <ul aria-label={words.vault.parts} className="flex flex-col">
          {parts.map((p) => {
            const price = priceOf(entry, p.asset);
            return (
              <li
                key={p.asset}
                className="flex items-center justify-between gap-[0.75em] border-t border-border py-[0.6em]"
              >
                <span>
                  {tokenName(p.asset)} · {share(lang, p.weightBps)}
                </span>
                {p.valueUsd !== null && price ? (
                  <ProvenancePin
                    value={dollars(lang, p.valueUsd)}
                    obs={positionValueSource(vault, price, t.portfolio.vault.positionMethod)}
                    labels={t.pin}
                  />
                ) : (
                  <span className="text-muted-foreground">{t.portfolio.vault.noPrice}</span>
                )}
              </li>
            );
          })}
        </ul>
        <a href={page} target="_blank" rel="noopener" className={`${PARTNER_BUTTON} no-underline`}>
          {words.vault.see}
        </a>
        <Disclaimer lang={lang} label={t.shell.disclaimer} />
      </EmbedShell>
    </div>
  );
}
