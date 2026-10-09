'use client';
import type { ChainId, MixLine, Provenance } from '@colosseum/schemas';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { useT } from '../../i18n/I18nProvider';
import { onMock } from '../order/readiness';
import { unitsFor } from '../order/units';
import { useWalletPort } from '../wallet/WalletProvider';
import { ApplyVaultMix } from './ApplyVaultMix';
import { type EditorLine, mixOf, sameMix } from './mix';
import { linesOf, WeightEditor, type Weights, weightsOf } from './WeightEditor';

// New weights for a vault the person owns (gate ANY-COMPOSITION, #191): the weights to start from, the
// vault's targets or a conversation's preview, in fields the person may change, then the server's
// review of exactly what the fields say. A preview's weights are sent as the model's only while the
// person left them as they came.

export function VaultMixFlow({
  chain,
  vault,
  seed,
  from,
  provenance,
  names,
  onClose,
}: {
  chain: ChainId;
  vault: { address: string; owner: string; basketId: string; cash: { asset: string } };
  /** The weights the fields start with; a cash line among them is left out, as cash is the rest. */
  seed: readonly MixLine[];
  /** Who chose the seed: a conversation's preview, or the vault's own targets. */
  from: 'model' | 'person';
  provenance: Provenance;
  names?: Readonly<Record<string, string>>;
  /** Leaves the editor, where there is something to go back to. */
  onClose?: () => void;
}) {
  const t = useT();
  const e = t.mix.editor;
  const port = useWalletPort();
  const titleId = useId();
  const mock = onMock(port, chain);
  const cash = unitsFor(chain, mock)?.cash ?? vault.cash.asset;
  const start = seed.filter((line) => line.assetId !== cash);
  const [weights, setWeights] = useState<Weights | null>(null);
  const [reviewing, setReviewing] = useState<EditorLine[] | null>(null);
  const shown = weights ?? weightsOf(start);
  const lines = linesOf(shown, cash);

  if (reviewing)
    return (
      <ApplyVaultMix
        chain={chain}
        vault={vault}
        lines={mixOf(reviewing, cash)}
        origin={from === 'model' && sameMix(reviewing, start) ? 'model' : 'person'}
        onBack={() => setReviewing(null)}
      />
    );
  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      mock={provenance !== 'live'}
      mockLabels={{
        announce: provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
      }}
    >
      <CardHeader id={titleId} title={e.weights} level={2} meta={t.chain.names[chain]} />
      <CardBody className="flex min-w-0 flex-col gap-4">
        {from === 'model' && <p className="max-w-(--tf-measure-body) text-body-sm">{e.fromChat}</p>}
        <WeightEditor
          chain={chain}
          mock={mock}
          cash={cash}
          value={shown}
          onChange={setWeights}
          names={names}
        />
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            data-action="targets-review"
            disabled={!lines}
            onClick={() => lines && setReviewing(lines)}
          >
            {t.mix.vault.review}
          </Button>
          {onClose && (
            <Button variant="secondary" onClick={onClose}>
              {e.close}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
