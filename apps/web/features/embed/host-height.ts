'use client';
import { useEffect } from 'react';

// The embed tells its host how tall it is, so the host can size the frame and there is no scroll
// inside it (embed-shell.md). One message, `{ type: 'tenonfi:embed-height', height }`, each time the
// page's height changes. It carries the height and nothing else, so it goes to any host (`'*'`): the
// frame-ancestors policy (next.config.ts) is what decides which hosts may frame the page at all.

export const HEIGHT_MESSAGE = 'tenonfi:embed-height';

export function useHostHeight(): void {
  useEffect(() => {
    if (window.parent === window) return;
    let last = -1;
    const send = () => {
      const height = Math.ceil(document.documentElement.scrollHeight);
      if (height === last) return;
      last = height;
      window.parent.postMessage({ type: HEIGHT_MESSAGE, height }, '*');
    };
    send();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(send);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
}
