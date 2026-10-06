'use client';
import { useEffect, useRef } from 'react';
import { createJointScene } from '../../../../features/landing/joint-scene';

// The joint alone on a clear ground, apart (`?state=apart`) or seated (`?state=seated`), in the theme
// of the `tf-theme` cookie: what scripts/joint-stills.mjs photographs for the stills of the landing's
// fallbacks (features/landing/JointStill.tsx). `page.dev.tsx` is a route only under `next dev`.

export default function Page() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const seated = new URLSearchParams(window.location.search).get('state') === 'seated';
    const scene = createJointScene(el, {
      still: true,
      onReady: () => requestAnimationFrame(() => el.setAttribute('data-ready', 'true')),
    });
    scene.setProgress(seated ? 1 : 0);
    return () => scene.dispose();
  }, []);
  return (
    <>
      <style>{'html, body { background: transparent !important; }'}</style>
      <canvas ref={canvas} data-ui="joint-still-source" className="block size-[480px]" />
    </>
  );
}
