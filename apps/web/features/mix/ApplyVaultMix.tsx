'use client';
import type { ChainId, MixLine, MixOrigin, MixReview } from '@colosseum/schemas';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { useLang, useT } from '../../i18n/I18nProvider';
import { keepOrder } from '../order/order-record';
import { onMock } from '../order/readiness';
import { isVaultOf } from '../shared/chain-recipe';
import type { SharedTerms } from '../shared/terms';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { useFailureText } from './failure';
import { MixReviewCard, useTicks } from './MixReviewCard';
import { acceptedOf } from './mix';
import { applyVaultMix } from './mix-api';

// New targets for a vault the person owns (gate ANY-COMPOSITION, #191), from the vault conversation's
// preview or the weight editor: the server's review with each warning ticked, then the order, which the
// order screen signs step by step. The targets the guard holds the first step to are the review's,
// kept with the order in this browser, never the order the API answered.

export function ApplyVaultMix({
  chain,
  vault,
  lines,
  origin,
  onBack,
  onOrder,
}: {
  chain: ChainId;
  vault: { address: string; owner: string; basketId: string };
  lines: readonly MixLine[];
  origin: MixOrigin;
  onBack: () => void;
  /** A host that shows the order's steps itself (the vault's own page): handed the order, no page is opened. */
  onOrder?: (orderId: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const v = t.mix.vault;
  const api = useApiFetch();
  const port = useWalletPort();
  const router = useRouter();
  const failureText = useFailureText();
  const [review, setReview] = useState<MixReview | null>(null);
  const [changed, setChanged] = useState(false);
  const [ticked, tick] = useTicks(review);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sent = JSON.stringify(lines);
  const asked = useRef<string | null>(null);

  const body = (confirm: boolean, read: MixReview | null) => ({
    version: 1 as const,
    origin,
    language: lang,
    allocations: lines.map(({ assetId, weightBps }) => ({ assetId, weightBps })),
    confirm,
    acceptedWarnings: read && confirm ? acceptedOf(read, ticked) : [],
    ...(read && confirm ? { reviewHash: read.reviewHash } : {}),
  });

  // The review is asked for once per set of lines; nothing is built or stored by it. An ask that is
  // dropped before its answer (the screen left, or mounted twice in development) is made again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lines are compared by their text
  useEffect(() => {
    if (asked.current === sent) return;
    asked.current = sent;
    let mine = true;
    let answered = false;
    setReview(null);
    setFailure(null);
    applyVaultMix(api, chain, vault.address, vault.owner, body(false, null)).then((answer) => {
      if (!mine) return;
      answered = true;
      if (answer.kind !== 'ok') return setFailure(failureText(answer));
      setReview(answer.value.review);
    });
    return () => {
      mine = false;
      if (!answered) asked.current = null;
    };
  }, [api, chain, vault.address, vault.owner, sent]);

  async function confirm() {
    if (!review || !port.userId) return;
    // The plan number the steps name has to be this vault's own, as the guard derives its address.
    if (isVaultOf(chain, onMock(port, chain), vault.owner, vault.basketId, vault.address) === false)
      return setFailure(t.mix.failure.notYours);
    setBusy(true);
    setFailure(null);
    const answer = await applyVaultMix(api, chain, vault.address, vault.owner, body(true, review));
    if (answer.kind !== 'ok') {
      setBusy(false);
      return setFailure(failureText(answer));
    }
    if (answer.value.status === 'review') {
      setBusy(false);
      setChanged(true);
      setReview(answer.value.review);
      return;
    }
    const { order } = answer.value;
    const terms: SharedTerms = {
      kind: 'retarget',
      vault: vault.address,
      basketId: vault.basketId,
      targets: review.targets,
      origin,
    };
    const kept = keepOrder({
      orderId: order.id,
      userId: port.userId,
      proposalId: '',
      chain,
      amountUsd: 0,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      setBusy(false);
      return setFailure(t.mix.failure.noStore);
    }
    if (onOrder) {
      setBusy(false);
      return onOrder(order.id);
    }
    router.push(`/orders/${encodeURIComponent(order.id)}`);
  }

  const said = failure && (
    <p
      role="alert"
      className="max-w-(--tf-measure-body) whitespace-pre-line text-body-sm text-destructive"
    >
      {failure}
    </p>
  );
  if (!review)
    return failure ? (
      <div className="flex flex-col items-start gap-3">
        {said}
        <Button variant="secondary" onClick={onBack}>
          {t.mix.review.back}
        </Button>
      </div>
    ) : (
      <Card>
        <CardWait label={v.reviewing} skeleton={<SkeletonSummary />} />
      </Card>
    );
  return (
    <div data-ui="apply-vault-mix" className="flex flex-col gap-3">
      <MixReviewCard
        review={review}
        ticked={ticked}
        onTick={tick}
        confirmLabel={busy ? v.confirming : v.confirm}
        onConfirm={confirm}
        onBack={onBack}
        busy={busy}
        changed={changed}
      />
      <p className="max-w-(--tf-measure-body) text-caption text-muted-foreground">{v.after}</p>
      {said}
    </div>
  );
}
