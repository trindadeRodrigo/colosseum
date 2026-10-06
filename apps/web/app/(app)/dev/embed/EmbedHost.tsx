'use client';
import { useEffect, useRef, useState } from 'react';
import { HEIGHT_MESSAGE } from '../../../../features/embed/host-height';

// The partner's side, as a host app would write it: a frame per skin, each sized by the height the
// embed posts. The skins are named in the frame's address (features/embed/theme.ts); the sample
// partner is the one in guidelines.html section 08 (`.partner-app`), not ours.

const SKINS: { name: string; query: string; ground: string }[] = [
  { name: 'System, light', query: 'scheme=light', ground: '#F2F2F2' },
  { name: 'System, dark', query: 'scheme=dark', ground: '#0F0F11' },
  {
    name: 'Sample partner (guidelines.html §08)',
    query:
      'scheme=light&fg=%231E1E1E&bg=%23FFFFFF&muted=%236A6A6A&border=%23E4E4E4&accent=%231E1E1E&radius=14px&font=system-ui',
    ground: '#F2F2F2',
  },
];

function Frame({ src, title }: { src: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; height?: unknown };
      if (data?.type === HEIGHT_MESSAGE && typeof data.height === 'number' && data.height > 0)
        setHeight(Math.min(data.height, 4000));
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);
  return (
    <iframe
      ref={frame}
      src={src}
      title={title}
      style={{ width: '100%', height, border: 0, display: 'block' }}
    />
  );
}

export function EmbedHost({ vault, width }: { vault: string | null; width: number }) {
  return (
    <div data-ui="embed-host" className="flex flex-col gap-8">
      <h1 className="font-sans text-h2 font-semibold">Partner embed, on a stand-in host</h1>
      <div className="flex flex-wrap items-start gap-6">
        {SKINS.map((skin) => (
          <section
            key={skin.name}
            aria-label={skin.name}
            style={{ background: skin.ground, padding: 24, width: width + 48 }}
          >
            <p style={{ font: '12px system-ui', color: '#6A6A6A', margin: '0 0 12px' }}>
              {skin.name}
            </p>
            <Frame src={`/embed?${skin.query}`} title={`tenonfi embed, ${skin.name}`} />
            {vault && (
              <div style={{ marginTop: 16 }}>
                <Frame
                  src={`/embed/${vault}?${skin.query}`}
                  title={`tenonfi vault, ${skin.name}`}
                />
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
