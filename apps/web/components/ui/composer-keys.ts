// Which key sends what is in the typing box (composer.md). A plain module, so the rule can be read and
// tested without the component.

/** What Safari reports as the key code of a key an input method has already taken. */
const IME_KEY_CODE = 229;

/**
 * Enter sends. Shift+Enter is a new line. While an input method is composing, Enter is its own: it
 * picks the candidate. Safari ends the composition before it reports that Enter, so `isComposing` is
 * already false there; the key code (229) is what still says the key was the input method's.
 */
export function sendsOnKey(event: {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  const composing =
    (event.nativeEvent?.isComposing ?? event.isComposing ?? false) ||
    (event.nativeEvent?.keyCode ?? event.keyCode) === IME_KEY_CODE;
  return event.key === 'Enter' && !event.shiftKey && !composing;
}
