'use client';
import { type ChainId, chainFamily } from '@colosseum/schemas';
import { useId, useState } from 'react';
import { ChoiceChip } from '../../components/shell/ChoiceChip';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/ui/Card';
import { shorten } from '../../components/ui/format';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import { useWalletPort } from '../wallet/WalletProvider';
import { useAccount } from './AccountProvider';
import { ChainMark } from './ChainName';
import { PersonError } from './person';

// Gate CHAIN-PICK: a person who made their wallet in the app chooses the chain their plan lives on,
// once. The screen says what the choice means and that it stands. A person who connected an outside
// wallet never sees this: their chain is that wallet's, and the API says so (AccountProvider).

export type ChainPickProps = {
  options: readonly ChainId[];
  /** The person pressed the button that stores their choice: the screen may be about to change. */
  onConfirm?: () => void;
  /** It was not stored, and the card says why. */
  onFailed?: () => void;
};

export function ChainPick({ options, onConfirm, onFailed }: ChainPickProps) {
  const t = useT();
  const port = useWalletPort();
  const { pick, mock } = useAccount();
  // One chain to choose from is still a choice the person confirms: it cannot be undone.
  const [chosen, setChosen] = useState<ChainId | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const titleId = useId();
  const whyId = useId();
  const name = (chain: ChainId) => port.network(chain)?.name ?? t.chain.names[chain];
  // A chain our server has switched off is not offered: choosing it could never be stored. It is
  // named, so the person knows why it is not there.
  const off = options.filter((chain) => port.network(chain)?.on === false);
  const open = options.filter((chain) => !off.includes(chain));
  // Asked for one of two reasons: the wallet was made here, or outside wallets of both kinds are linked.
  const made = port.accounts.some((account) => account.kind === 'embedded');

  async function confirm() {
    if (!chosen || busy || !open.includes(chosen)) return;
    onConfirm?.();
    setBusy(true);
    setProblem(null);
    try {
      await pick(chosen);
    } catch (e) {
      const kind = e instanceof PersonError ? e.kind : 'unreachable';
      // Chosen before, elsewhere: the screen still changes, to where the plan does live.
      if (kind !== 'taken') onFailed?.();
      setProblem(
        // The account reads where the plan does live, and the screen names that chain (SignInScreen).
        // This is said only if it could not be read, while the question is still on the page.
        kind === 'taken'
          ? t.chain.failure.takenUnknown(name(chosen))
          : kind === 'not_offered'
            ? t.chain.failure.notOffered
            : kind === 'signed_out'
              ? t.chain.failure.signedOut
              : kind === 'no_identity'
                ? t.chain.failure.noIdentity
                : kind === 'busy'
                  ? t.shell.slowDown
                  : t.chain.failure.unreachable,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      mock={mock}
      mockLabels={{ announce: t.shell.mockAnnounce }}
    >
      <CardHeader title={t.chain.pick.title} level={2} id={titleId} />
      <CardBody className="flex flex-col gap-4">
        <p className="max-w-(--tf-measure-body) text-body">
          {made ? t.chain.pick.asked.made : t.chain.pick.asked.connected} {t.chain.pick.body}
        </p>
        <p className="text-body font-medium">{t.chain.pick.warning}</p>
        {open.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: two toggle buttons are the group; a fieldset is for form controls
          <div role="group" aria-label={t.chain.pick.group} className="flex flex-col gap-3">
            {open.map((chain, index) => {
              const network = port.network(chain);
              const account = port.active(chainFamily(chain));
              return (
                <div key={chain} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ChoiceChip
                    chosen={chosen === chain}
                    disabled={busy}
                    onChoose={() => setChosen(chain)}
                  >
                    {name(chain)}
                  </ChoiceChip>
                  {/* The throwaway wallet marks the whole card, so its chains carry no mark of their own. */}
                  {network && !mock && (
                    <ChainMark
                      provenance={network.provenance}
                      labels={{
                        testNetwork: t.shell.testNetwork,
                        mockAnnounce: t.shell.mockAnnounce,
                      }}
                      announce={index === 0}
                    />
                  )}
                  {account && (
                    <span className="font-mono text-source text-muted-foreground">
                      {t.chain.pick.address(shorten(account.address))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {off.map((chain) => (
          <p key={chain} data-ui="chain-off" className="text-body-sm text-muted-foreground">
            {t.chain.pick.off(name(chain))}
          </p>
        ))}
        {open.length === 0 && <p className="text-body">{t.chain.pick.noneOn}</p>}
        {mock && <p className="text-body-sm text-muted-foreground">{t.chain.pick.mock}</p>}
      </CardBody>
      <CardFooter className="flex flex-col items-start gap-2">
        {open.length > 0 && (
          <Button
            variant="primary"
            disabled={chosen === null}
            busy={busy}
            busyLabel={t.chain.pick.saving}
            aria-describedby={chosen === null ? whyId : undefined}
            onClick={confirm}
          >
            {chosen === null ? t.chain.pick.confirmNone : t.chain.pick.confirm(name(chosen))}
          </Button>
        )}
        {open.length > 0 && chosen === null && (
          <p id={whyId} className="text-caption text-muted-foreground">
            {t.chain.pick.why}
          </p>
        )}
        {problem && (
          <p role="alert" className="flex items-start gap-1.5 text-body-sm text-destructive">
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>{problem}</span>
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
