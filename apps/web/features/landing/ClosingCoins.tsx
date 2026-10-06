'use client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { useT } from '../../i18n/I18nProvider';
import { CoinsStill } from './CoinsStill';
import { COINS, closingProgress, clusterFrame, labelOf, lineAt } from './coins';
import type { CoinsScene } from './coins-scene';
import { hasWebGL } from './JointStage';

// The closing's stage (gate CLOSING-COINS, Thom, Oct 6): no frame. The assets a plan is made of, as
// round coins with their tickers, drift loose around the heading and gather, one by one, into one plan
// beside it as the reader scrolls the section in; each coin as large as its share of a sample plan, its
// share on its face once the plan is whole, then one line under it. Scrolling back sets them loose
// again. The section holds for one screen (a short sticky stretch, no scroll-jacking), and the scene
// eases toward the scroll, so it never jumps. The words stay on top.
//
// - Motion allowed, WebGL on a real GPU, data not saved, not a small device: one canvas, made only
//   when the section comes near, drawn only while it is on screen and moving.
// - Otherwise (and before the canvas is ready, and without script): the plan drawn flat in ink, whole,
//   where the cluster stands. Reduced motion: nothing holds or moves; the plan beside the heading.

/** The scene's module, fetched only when it is wanted (a seam for its test). */
export const coinsModule = { load: () => import('./coins-scene') };

/** How near the section must come, in screens, before the scene is loaded. */
const NEAR = '100% 0px 100% 0px';

/** A device too small to scrub a 3D scene smoothly: few cores or little memory, or data saved. */
function lowPower(): boolean {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  return (
    nav.connection?.saveData === true ||
    (nav.hardwareConcurrency ?? 8) <= 2 ||
    (nav.deviceMemory ?? 8) <= 2
  );
}

const pct = (bps: number) => `${bps / 100}%`;

export function ClosingCoins({ label, children }: { label: string; children: ReactNode }) {
  const t = useT().landing.closing;
  const track = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<CoinsScene | null>(null);
  const [mode, setMode] = useState<'still' | '3d'>('still');
  /** The reader's progress through the section, for the line under the plan. */
  const [progress, setProgress] = useState(1);
  /** The stage's size, once measured: where the cluster stands is worked out from it. */
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    const host = track.current;
    const el = canvas.current;
    if (!host || !el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (lowPower() || !hasWebGL()) return;

    let alive = true;
    let frame = 0;
    const read = () => {
      frame = 0;
      const r = host.getBoundingClientRect();
      const p = closingProgress(r.top, r.height, window.innerHeight);
      scene.current?.setProgress(p);
      setProgress(p);
    };
    // Scroll only schedules a read; the scene eases toward it on its own frames.
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    const onResize = () => {
      scene.current?.resize();
      onScroll();
    };
    const onHidden = () => scene.current?.setVisible(document.visibilityState === 'visible');

    let loading = false;
    const load = () => {
      loading = true;
      coinsModule
        .load()
        .then(({ createCoinsScene }) => {
          if (!alive) return;
          try {
            scene.current = createCoinsScene(el, {
              onReady: () => alive && setMode('3d'),
              light: window.innerWidth < 960,
            });
          } catch {
            return; // the still stays
          }
          read();
          window.addEventListener('scroll', onScroll, { passive: true });
          window.addEventListener('resize', onResize);
          document.addEventListener('visibilitychange', onHidden);
        })
        .catch(() => {}); // the chunk did not come: the still stays
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        const near = entry?.isIntersecting ?? false;
        if (near && !loading) load();
        scene.current?.setVisible(near);
      },
      { rootMargin: NEAR },
    );
    observer.observe(host);
    return () => {
      alive = false;
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onHidden);
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  // Where the cluster stands, once the stage is measured; before that the still takes its CSS place.
  const frame = box ? clusterFrame(box.w, box.h) : null;
  const shown = mode === '3d' ? lineAt(progress) : 1;
  return (
    <div
      ref={track}
      data-ui="closing-track"
      data-mode={mode}
      // two screens: one to come in, one held (the sticky stretch); one screen with reduced motion
      className="relative -mx-[clamp(16px,4vw,56px)] h-[200svh] self-stretch motion-reduce:h-svh"
    >
      <div ref={stage} className="sticky top-0 h-svh w-full overflow-hidden">
        <canvas
          ref={canvas}
          role="img"
          aria-label={label}
          aria-hidden={mode === '3d' ? undefined : true}
          data-ui="closing-canvas"
          className={cn(
            'pointer-events-none absolute inset-0 z-0 h-full w-full transition-opacity duration-700',
            mode === '3d' ? 'opacity-100' : 'opacity-0',
          )}
        />
        {mode === 'still' && (
          <div
            data-ui="closing-still"
            style={
              frame
                ? {
                    left: frame.cx - frame.radius,
                    top: frame.cy - frame.radius,
                    width: frame.radius * 2,
                  }
                : undefined
            }
            className={cn(
              'pointer-events-none absolute z-0',
              !frame &&
                'top-[6svh] left-1/2 w-[min(260px,62vw,38svh)] -translate-x-1/2 closing-wide:top-1/2 closing-wide:right-[10vw] closing-wide:left-auto closing-wide:w-[min(440px,34vw)] closing-wide:translate-x-0 closing-wide:-translate-y-1/2',
            )}
          >
            <CoinsStill label={label} className="h-auto w-full" />
          </div>
        )}
        {/* under the plan, once it is whole: what it is, and that its shares are a sample */}
        {frame && (
          <div
            data-ui="closing-plan-line"
            style={{
              left: frame.cx - frame.radius * 1.4,
              top: frame.cy + frame.radius + 14,
              width: frame.radius * 2.8,
              opacity: shown,
            }}
            className="pointer-events-none absolute z-10 flex flex-col items-center"
          >
            <p className="text-body font-medium">{t.coins.line}</p>
            <p data-ui="sample-note" className="mt-1 text-caption text-muted-foreground">
              {t.coins.sample}
            </p>
          </div>
        )}
        {/* the plan's parts, for a screen reader: the coins' faces are drawn */}
        <ul className="sr-only" aria-label={t.coins.parts}>
          {COINS.map((coin) => (
            <li key={coin.ticker}>{labelOf(coin, pct)}</li>
          ))}
        </ul>
        {/* the words, on top: beside the plan, or under it on a phone */}
        <div
          data-ui="closing-words"
          className={cn(
            'relative z-10 mx-auto flex h-full w-full max-w-page flex-col items-center justify-end px-[clamp(16px,4vw,56px)] pb-[10svh] [&>*]:max-w-[34rem]',
            'closing-wide:items-start closing-wide:justify-center closing-wide:pb-0 closing-wide:text-left closing-wide:[&>*]:max-w-[min(34rem,50%)]',
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
