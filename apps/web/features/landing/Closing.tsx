'use client';
import { useState } from 'react';
import { SubscribeBlock, type SubscribeStatus } from '../../components/ui/SubscribeBlock';
import { useT } from '../../i18n/I18nProvider';
import { Closing3D } from './Closing3D';

// "Built piece by piece." (subscribe-block.md): the closing section and its email field. Sign-ups are
// not open: there is no route that takes an address, so nothing typed here is sent or kept, and the
// block says so before and after. The checks of the address are the block's own. Its picture is the
// hero's joint in 3D, coming together behind the heading as the reader scrolls (Closing3D, gate
// CLOSING-INK), with no frame; the field sits under it, centred.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Closing() {
  const t = useT().landing.closing;
  const [status, setStatus] = useState<SubscribeStatus>('rest');
  return (
    <section
      id="updates"
      aria-label={t.label}
      className="relative z-[2] scroll-mt-22 bg-background pb-[clamp(72px,10vw,140px)]"
    >
      <div className="mx-auto w-full px-[clamp(16px,4vw,56px)]">
        <SubscribeBlock
          eyebrow={t.eyebrow}
          heading={t.title}
          lede={t.lede}
          stage={(head) => <Closing3D label={t.drawingAlt}>{head}</Closing3D>}
          options={[
            { id: 'updates', label: t.updates },
            { id: 'newsletter', label: t.newsletter },
          ]}
          status={status}
          placeholder="you@example.com"
          onSubmit={(email, options) =>
            setStatus(
              !EMAIL.test(email) ? 'invalid-email' : options.length === 0 ? 'no-option' : 'success',
            )
          }
          labels={{
            email: t.email,
            subscribe: t.subscribe,
            subscribing: t.subscribing,
            group: t.group,
            status: t.status,
          }}
        />
      </div>
    </section>
  );
}
