'use client';
import { useState } from 'react';
import { SubscribeBlock, type SubscribeStatus } from '../../components/ui/SubscribeBlock';
import { useT } from '../../i18n/I18nProvider';
import { ClosingDrawing } from './ClosingDrawing';

// "Built piece by piece." (subscribe-block.md): the closing section and its email field. Sign-ups are
// not open: there is no route that takes an address, so nothing typed here is sent or kept, and the
// block says so before and after. The checks of the address are the block's own. Its picture is the
// hero's joint drawn exploded, coming together (ClosingDrawing, gate CLOSING-INK), not a photograph.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Closing() {
  const t = useT().landing.closing;
  const [status, setStatus] = useState<SubscribeStatus>('rest');
  return (
    <section
      id="updates"
      aria-label={t.label}
      className="relative z-[2] scroll-mt-22 bg-background pt-[clamp(56px,8vw,120px)] pb-[clamp(72px,10vw,140px)]"
    >
      <div className="mx-auto w-full max-w-page px-[clamp(16px,4vw,56px)]">
        <SubscribeBlock
          eyebrow={t.eyebrow}
          heading={t.title}
          lede={t.lede}
          art={<ClosingDrawing label={t.drawingAlt} className="aspect-[12/13] w-full" />}
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
