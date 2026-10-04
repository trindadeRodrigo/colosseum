import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// For the few tests that must fire an event: a click on a busy button, Enter in the composer, Escape
// on an open pin. They mount the primitive with React's own client renderer in happy-dom, a DOM
// written in JavaScript (a dev dependency of the repository; nothing the app ships). A test file
// asks for it with `// @vitest-environment happy-dom` on its first line. Everything else is still
// tested as server markup (test/html.ts), with no DOM at all.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

/** Mounts a node in the document and returns the element that holds it. */
export async function mount(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  mounted.push({ root, host });
  return host;
}

/** Unmounts everything `mount` put in the document. Call it after each test. */
export async function unmountAll(): Promise<void> {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

/** The one element that matches, or an error that says what was looked for. */
export function find<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelectorAll<T>(selector);
  if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
  return found[0] as T;
}

/** A click as the browser makes one: the event, then what the element does by default (a submit). */
export async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

export async function press(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

export async function fire(target: EventTarget, event: Event): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

/** Types into a field the way React hears it: the value, then an `input` event. */
export async function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Lets timers and effects that are due run, inside React's `act`. */
export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
