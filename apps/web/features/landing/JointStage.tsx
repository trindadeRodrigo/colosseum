'use client';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { useT } from '../../i18n/I18nProvider';
import { JointDrawing } from './JointDrawing';
import type { JointScene } from './joint-scene';

// The pinned hero of his landing page (joint-stage.md): the joint sits behind the copy and seats as the
// reader scrolls through the three steps, then the stage lets go and scrolls away. The pose follows the
// reader and nothing else: there is no loop and no idle motion.
//
// - Motion allowed, WebGL there, data not saved: the 3D scene, loaded once the stage is in view, drawn
//   only while the pose moves and the stage is on screen.
// - No WebGL, or data saved: the line drawing in the same pinned layer, exploded, then seated from
//   step 03.
// - Reduced motion: nothing is pinned. The drawing stands beside the copy, seated, and the steps scroll
//   as text. This is CSS alone, so the server's page is already right.
// The copy is the page's: a screen reader and a keyboard reach every step in order, whatever is drawn.

/** Where step 03 sits: the bar compacts there (CompactNav), and the joint is seated there. */
export const STEP_IDS = ['step-1', 'step-2', 'step-3'] as const;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function JointStage() {
  const t = useT().landing.stage;
  const stage = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<JointScene | null>(null);
  const [progress, setProgress] = useState(0);
  const [on, setOn] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);

  // The reader's progress, and which step is in the middle of the screen.
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const step3 = document.getElementById(STEP_IDS[2]);
      const vh = window.innerHeight;
      if (step3) {
        const end = step3.offsetTop + step3.offsetHeight / 2 - vh / 2;
        const p = clamp(window.scrollY / Math.max(end, 1), 0, 1);
        setProgress(p);
        scene.current?.setProgress(p);
      }
      const middle = STEP_IDS.findIndex((id) => {
        const r = document.getElementById(id)?.getBoundingClientRect();
        if (!r) return false;
        const mid = r.top + r.height / 2;
        return mid > vh * 0.15 && mid < vh * 0.85;
      });
      setOn(middle < 0 ? null : middle);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  // The 3D scene: only where it can run and is wanted, and only once the stage is near.
  useEffect(() => {
    const el = canvas.current;
    const host = stage.current;
    if (!el || !host) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData =
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
      true;
    if (reduce || saveData || !hasWebGL()) return;
    let alive = true;
    let observer: IntersectionObserver | null = null;
    const onResize = () => scene.current?.resize();
    const onHidden = () => scene.current?.setVisible(document.visibilityState === 'visible');
    const start = () =>
      import('./joint-scene').then(({ createJointScene }) => {
        if (!alive) return;
        try {
          scene.current = createJointScene(el);
        } catch {
          return; // the drawing stays
        }
        setDrawn(true);
        const step3 = document.getElementById(STEP_IDS[2]);
        const vh = window.innerHeight;
        const end = step3 ? step3.offsetTop + step3.offsetHeight / 2 - vh / 2 : 1;
        scene.current.setProgress(clamp(window.scrollY / Math.max(end, 1), 0, 1));
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', onHidden);
        observer = new IntersectionObserver(([entry]) =>
          scene.current?.setVisible(entry?.isIntersecting ?? false),
        );
        observer.observe(host);
      });
    // After the first paint: the heading is what a person reads first, not the canvas.
    const idle = window.setTimeout(start, 0);
    return () => {
      alive = false;
      window.clearTimeout(idle);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onHidden);
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  const seated = progress >= 0.72;
  return (
    <section ref={stage} id="stage" aria-label={t.label} data-ui="joint-stage" className="relative">
      {/* The pinned layer: one screen tall, under the copy. Not drawn at all with reduced motion. */}
      <div
        aria-hidden="true"
        className="sticky top-0 z-0 -mb-[100svh] h-svh overflow-hidden motion-reduce:hidden"
      >
        <canvas ref={canvas} className={cn('block size-full', !drawn && 'invisible')} />
        {!drawn && (
          <div className="absolute inset-0 mx-auto flex max-w-page items-center justify-end px-[clamp(16px,4vw,56px)] max-[819px]:items-start max-[819px]:justify-center max-[819px]:pt-24">
            <JointDrawing
              seated={seated}
              className="w-[min(440px,70vw)] max-[819px]:w-[min(300px,70vw)]"
            />
          </div>
        )}
      </div>
      <div className="relative z-[1] mx-auto w-full max-w-page px-[clamp(16px,4vw,56px)]">
        <div className="flex min-h-svh items-center max-[819px]:items-end max-[819px]:pb-[10vh] motion-reduce:min-h-0 motion-reduce:items-start motion-reduce:py-28">
          <div className="grid w-full items-center gap-10 min-[820px]:grid-cols-[minmax(0,560px)_1fr]">
            <div className="max-w-[560px] min-w-0 pt-18 max-[819px]:-mx-[clamp(16px,4vw,56px)] max-[819px]:bg-background max-[819px]:px-[clamp(16px,4vw,56px)] max-[819px]:py-6 max-[819px]:pt-10 motion-reduce:pt-0">
              <h1 className="font-display text-[clamp(2.4rem,1.6rem+2.6vw,4rem)]/[1.12] font-normal tracking-[-0.015em] [overflow-wrap:break-word]">
                {t.title}
              </h1>
              <p className="mt-7 max-w-[44ch] text-[1.125rem]/[1.7] text-muted-foreground">
                <b className="font-medium text-foreground">{t.taglineStrong}</b>
                <br />
                {t.tagline}
              </p>
              {/* A still line, not a loop (joint-stage.md: no ambient motion). */}
              <p className="mt-10 flex items-center gap-2.5 font-mono text-[12px] text-muted-foreground motion-reduce:hidden">
                <span aria-hidden="true" className="inline-block h-7 w-px bg-muted-foreground" />
                {t.cue}
              </p>
            </div>
            {/* With reduced motion the joint stands here, seated, and does not move. */}
            <JointDrawing
              seated
              title={t.drawing}
              className="hidden w-full max-w-[440px] justify-self-end motion-reduce:block"
            />
          </div>
        </div>
        {t.steps.map((step, i) => (
          <div
            key={step.n}
            id={STEP_IDS[i]}
            className="flex min-h-[80vh] items-center max-[819px]:items-end max-[819px]:pb-[8vh] motion-reduce:min-h-0 motion-reduce:py-12"
          >
            <div
              data-on={on === i}
              className={cn(
                'max-w-[420px] transition-[color,transform] duration-[480ms] ease-seat motion-reduce:transition-none max-[819px]:-mx-[clamp(16px,4vw,56px)] max-[819px]:bg-background max-[819px]:px-[clamp(16px,4vw,56px)] max-[819px]:py-6',
                on === i ? 'translate-y-0' : 'translate-y-3 motion-reduce:translate-y-0',
              )}
            >
              <p className="font-mono text-[12px] font-medium tracking-[0.04em] text-primary">
                {step.n}
              </p>
              <h2
                className={cn(
                  'my-2 font-display text-[clamp(1.6rem,1.2rem+1.2vw,2.3rem)]/[1.2] font-normal transition-colors duration-[480ms]',
                  on === i
                    ? 'text-foreground'
                    : 'text-muted-foreground motion-reduce:text-foreground',
                )}
              >
                {step.title}
              </h2>
              <p className="text-muted-foreground">{step.body}</p>
            </div>
          </div>
        ))}
        <div aria-hidden="true" className="h-[45vh] motion-reduce:hidden" />
      </div>
    </section>
  );
}

function hasWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    return false;
  }
}
