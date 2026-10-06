'use client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { ClosingDrawing } from './ClosingDrawing';
import { CLOSING_BEARING, closingPoseAt, closingProgress, placeFor } from './closing-pose';
import { hasWebGL, sceneModule } from './JointStage';
import type { JointScene } from './joint-scene';

// The closing's stage (gate CLOSING-INK, Thom, Oct 6): no frame. The hero's joint, drawn by the hero's
// scene in the hero's ink, fills the section behind its heading and comes together as the reader
// scrolls it in, the pin last; scrolling back takes it apart. The section holds for one screen (a
// short sticky stretch, no scroll-jacking), and the pose follows the scroll through the scene's own
// damping, so it never jumps. The heading stays on top: the joint stands beside it, or above it on a
// phone, and is whole before the heading is read.
//
// - Motion allowed, WebGL on a real GPU, data not saved, not a small device: one canvas, made only
//   when the section comes near, drawn only while it is on screen and its pose moves.
// - Otherwise (and before the canvas is ready, and without script): the same joint as an ink drawing,
//   assembled and still, where the joint would stand.
// - Reduced motion: nothing holds and nothing moves; the assembled drawing beside the heading.

/** How near the section must come, in screens, before the scene is loaded. */
const NEAR = '100% 0px 100% 0px';

/** A device too small to scrub a 3D scene smoothly: few cores or little memory. */
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

export function Closing3D({ label, children }: { label: string; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<JointScene | null>(null);
  /** The still until the scene's first frame is drawn; the scene from then on. */
  const [mode, setMode] = useState<'still' | '3d'>('still');

  useEffect(() => {
    const host = track.current;
    const el = canvas.current;
    if (!host || !el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (lowPower() || !hasWebGL()) return;

    let alive = true;
    let frame = 0;
    const progress = () => {
      const r = host.getBoundingClientRect();
      return closingProgress(r.top, r.height, window.innerHeight);
    };
    const read = () => {
      frame = 0;
      scene.current?.setProgress(progress());
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
      sceneModule
        .load()
        .then(({ createJointScene }) => {
          if (!alive) return;
          try {
            scene.current = createJointScene(el, {
              onReady: () => alive && setMode('3d'),
              light: window.innerWidth < 960,
              stage: { pose: closingPoseAt, bearing: CLOSING_BEARING, place: placeFor },
            });
          } catch {
            return; // the still stays
          }
          scene.current.setProgress(progress());
          window.addEventListener('scroll', onScroll, { passive: true });
          window.addEventListener('resize', onResize);
          document.addEventListener('visibilitychange', onHidden);
        })
        .catch(() => {}); // the chunk did not come: the still stays
    };
    // Made when the section comes near, and paused while it is away.
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

  return (
    <div
      ref={track}
      data-ui="closing-track"
      data-mode={mode}
      // two screens: one to come in, one held (the sticky stretch); one screen with reduced motion
      className="relative -mx-[clamp(16px,4vw,56px)] h-[200svh] self-stretch motion-reduce:h-svh"
    >
      <div className="sticky top-0 h-svh w-full overflow-hidden">
        {/* the joint, behind the words */}
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
            className={cn(
              // above the heading; beside it on a wide screen (closing-pose.ts, `isNarrow`)
              'pointer-events-none absolute top-[6svh] left-1/2 z-0 w-[min(300px,62vw,38svh)] -translate-x-1/2',
              'closing-wide:top-1/2 closing-wide:right-[max(4vw,calc((100vw-var(--container-page))/2))] closing-wide:left-auto closing-wide:w-[min(440px,34vw)] closing-wide:translate-x-0 closing-wide:-translate-y-1/2',
            )}
          >
            <ClosingDrawing still label={label} className="h-auto w-full" />
          </div>
        )}
        {/* the words, on top: beside the joint, or under it on a phone */}
        <div
          data-ui="closing-words"
          className={cn(
            // under the joint on a phone, centred as the block is; beside it on a wide screen
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
