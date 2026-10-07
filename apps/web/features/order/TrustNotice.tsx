'use client';
import { type ChainId, TRUST_STATUS } from '@colosseum/schemas';
import { useId } from 'react';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps } from './amounts';

// The trust notice, from the one TRUST_STATUS constant (DESIGN-VAULT section 13), before the first
// deposit. First the four points in short: unaudited, the team's upgrade keys, the keeper's limits in
// numbers, and what issuers can do. Then the whole notice behind "Read the full list", every item as
// before: the upgrade key's address, who the product is not for, what a lost passkey means and the
// checks not run yet. The acceptance is ticked under both. The disclaimer is not repeated here: it is
// on the plan view, from its own constant.

export function TrustNotice({
  chain,
  accepted,
  checked,
  onCheck,
  keeper: keeperTrades = true,
}: {
  chain: ChainId;
  /**
   * The keeper may trade the vault this is shown for. False for a plan's own vault, which follows
   * nothing: the keeper's limits are then left out of the short points, and stay in the full list.
   */
  keeper?: boolean;
  /** Accepted before, in this browser, for this version of the text: nothing to tick. */
  accepted: boolean;
  /** Ticked now. It is kept as accepted when the order is made. */
  checked: boolean;
  onCheck: (yes: boolean) => void;
}) {
  const t = useT();
  const lang = useLang();
  const boxId = useId();
  const shortId = useId();
  const admin = TRUST_STATUS.admin[chain];
  const keeper = TRUST_STATUS.keeper[chain];
  const limits = keeper
    ? ([
        formatBps(keeper.toleranceBps, LOCALE[lang]),
        formatBps(keeper.weeklyLossCapBps, LOCALE[lang]),
      ] as const)
    : null;
  const short = [
    ...(TRUST_STATUS.audited ? [] : [t.trust.short.unaudited]),
    t.trust.short.keys,
    ...(keeperTrades ? [limits ? t.trust.short.keeper(...limits) : t.trust.short.keeperUnset] : []),
    ...(TRUST_STATUS.issuersCanFreeze ? [t.trust.short.issuers] : []),
  ];
  const items = [
    ...(TRUST_STATUS.audited ? [] : [t.trust.unaudited]),
    t.trust.keys,
    ...(admin ? [t.trust.admin(admin)] : []),
    limits ? t.trust.keeper(...limits) : t.trust.keeperUnset,
    ...(TRUST_STATUS.issuersCanFreeze ? [t.trust.issuers] : []),
    ...(TRUST_STATUS.usPersons === 'blocked' ? [t.trust.notUnitedStates] : []),
    ...(TRUST_STATUS.passkeyLoss ? [t.trust.passkey] : []),
    ...(TRUST_STATUS.openChecks.length
      ? [t.trust.openChecks(TRUST_STATUS.openChecks.map((c) => t.trust.checks[c]).join('; '))]
      : []),
  ];
  return (
    <div data-ui="trust-notice" className="flex flex-col gap-4">
      <p className="max-w-(--tf-measure-body) text-body">{t.trust.lead}</p>
      <div className="flex flex-col gap-2">
        <h3 id={shortId} className="text-body font-semibold">
          {t.trust.short.title}
        </h3>
        <ul
          data-ui="trust-short"
          aria-labelledby={shortId}
          className="flex max-w-(--tf-measure-body) list-disc flex-col gap-2 pl-5 text-body-sm"
        >
          {short.map((item) => (
            <li key={item} className="[overflow-wrap:anywhere]">
              {item}
            </li>
          ))}
        </ul>
      </div>
      <details data-ui="trust-full">
        <summary className="w-fit cursor-pointer text-body-sm font-medium text-primary underline decoration-1 underline-offset-4 hover:decoration-2">
          {t.trust.short.full}
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-body-sm font-semibold">{t.trust.title}</p>
          <ul className="flex max-w-(--tf-measure-body) list-disc flex-col gap-2 pl-5 text-body-sm">
            {items.map((item) => (
              <li key={item} className="[overflow-wrap:anywhere]">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </details>
      {accepted ? (
        <p className="text-body-sm text-muted-foreground">{t.trust.accepted}</p>
      ) : (
        <label htmlFor={boxId} className="inline-flex items-center gap-2 text-body">
          <input
            id={boxId}
            type="checkbox"
            className="size-4 accent-primary"
            checked={checked}
            onChange={(e) => onCheck(e.currentTarget.checked)}
          />
          {t.trust.accept}
        </label>
      )}
    </div>
  );
}
