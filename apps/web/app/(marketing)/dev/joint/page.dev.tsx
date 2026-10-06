'use client';
import { useEffect, useRef } from 'react';
import { drawingToSvg } from '../../../../features/landing/dev/joint-svg';
import { createJointScene } from '../../../../features/landing/joint-scene';

// The joint alone on a clear ground, apart (`?state=apart`) or seated (`?state=seated`), in the theme
// of the `tf-theme` cookie: what scripts/joint-stills.mjs turns into the SVG stills of the landing's
// fallbacks (features/landing/JointStill.tsx). `page.dev.tsx` is a route only under `next dev`.

export default function Page() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const query = new URLSearchParams(window.location.search);
    const scene = createJointScene(el, { still: true });
    scene.setProgress(query.get('state') === 'seated' ? 1 : 0);
    // the still option settles in one frame; the drawing is read after it
    const id = window.setTimeout(() => {
      el.dataset.svg = drawingToSvg(scene.inspect());
      el.setAttribute('data-ready', 'true');
    }, 400);
    return () => {
      window.clearTimeout(id);
      scene.dispose();
    };
  }, []);
  return (
    <>
      <style>{'html, body { background: transparent !important; }'}</style>
      <canvas ref={canvas} data-ui="joint-still-source" className="block size-[480px]" />
    </>
  );
}
