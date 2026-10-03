// Which key sends what is in the typing box (composer.md). A plain module, so the rule can be read and
// tested without the component.

/** Enter sends. Shift+Enter is a new line. While an input method is composing, Enter is its own. */
export function sendsOnKey(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
}): boolean {
  const composing = event.nativeEvent?.isComposing ?? event.isComposing ?? false;
  return event.key === 'Enter' && !event.shiftKey && !composing;
}
