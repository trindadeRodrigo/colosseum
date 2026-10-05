'use client';
import { type ChainId, TRUST_STATUS } from '@colosseum/schemas';
import { useId } from 'react';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps } from './amounts';

// The trust notice, from the one TRUST_STATUS constant (DESIGN-VAULT section 13), before the first
// deposit: unaudited, the team holds the upgrade keys, what the keeper may do in numbers, what issuers
// can do, who the product is not for, and what a lost passkey means. The disclaimer is not repeated
// here: it is on the plan view, from its own constant.

export function TrustNotice({
  chain,
  accepted,
  checked,
  onCheck,
}: {
  chain: ChainId;
  /** Accepted before, in this browser, for this version of the text: nothing to tick. */
  accepted: boolean;
  /** Ticked now. It is kept as accepted when the order is made. */
  checked: boolean;
  onCheck: (yes: boolean) => void;
}) {
  const t = useT();
  const lang = useLang();
  const titleId = useId();
  const boxId = useId();
  const admin = TRUST_STATUS.admin[chain];
  const keeper = TRUST_STATUS.keeper[chain];
  const items = [
    ...(TRUST_STATUS.audited ? [] : [t.trust.unaudited]),
    t.trust.keys,
    ...(admin ? [t.trust.admin(admin)] : []),
    keeper
      ? t.trust.keeper(
          formatBps(keeper.toleranceBps, LOCALE[lang]),
          formatBps(keeper.weeklyLossCapBps, LOCALE[lang]),
        )
      : t.trust.keeperUnset,
    ...(TRUST_STATUS.issuersCanFreeze ? [t.trust.issuers] : []),
    ...(TRUST_STATUS.usPersons === 'blocked' ? [t.trust.notUnitedStates] : []),
    ...(TRUST_STATUS.passkeyLoss ? [t.trust.passkey] : []),
    ...(TRUST_STATUS.openChecks.length
      ? [t.trust.openChecks(TRUST_STATUS.openChecks.map((c) => t.trust.checks[c]).join('; '))]
      : []),
  ];
  return (
    <div data-ui="trust-notice">
      <Card as="section" aria-labelledby={titleId}>
        <CardHeader title={t.trust.title} level={2} id={titleId} />
        <CardBody className="flex flex-col gap-4">
          <p className="max-w-(--tf-measure-body) text-body">{t.trust.lead}</p>
          <ul className="flex max-w-(--tf-measure-body) list-disc flex-col gap-2 pl-5 text-body-sm">
            {items.map((item) => (
              <li key={item} className="[overflow-wrap:anywhere]">
                {item}
              </li>
            ))}
          </ul>
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
        </CardBody>
      </Card>
    </div>
  );
}
