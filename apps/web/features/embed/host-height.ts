'use client';
import { useEffect } from 'react';

// The embed tells its host how tall it is, so the host can size the frame and there is no scroll
// inside it (embed-shell.md). One message, `{ type: 'tenonfi:embed-height', height }`, each time the
// page's height changes. It carries the height and nothing else, so it goes to any host (`'*'`): the
// frame-ancestors policy (next.config.ts) is what decides which hosts may frame the page at all.
// A host whose listener comes up after the embed's first message asks again with
// `{ type: 'tenonfi:embed-height-request' }`, and the embed answers its parent with the height.

export const HEIGHT_MESSAGE = 'tenonfi:embed-height';
export const HEIGHT_REQUEST = 'tenonfi:embed-height-request';

export function useHostHeight(): void {
  useEffect(() => {
    if (window.parent === window) return;
    let last = -1;
    const send = (again = false) => {
      const height = Math.ceil(document.documentElement.scrollHeight);
      if (height === last && !again) return;
      last = height;
      window.parent.postMessage({ type: HEIGHT_MESSAGE, height }, '*');
    };
    const asked = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === HEIGHT_REQUEST) send(true);
    };
    send();
    window.addEventListener('message', asked);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => send());
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('message', asked);
      observer?.disconnect();
    };
  }, []);
}
