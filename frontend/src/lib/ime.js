// A key pressed while an IME (Japanese, Chinese, Korean …) is composing belongs to the IME: Enter confirms the conversion
// candidate, Esc cancels the composition, arrows pick a candidate. A handler that acts on it commits half-typed text.
//
// React's SyntheticKeyboardEvent does NOT carry `isComposing` (its interface lists key, code, keyCode, which … only), so a React
// `onKeyDown` must read the native event; a plain `addEventListener` handler gets the native event itself. `keyCode === 229`
// (VK_PROCESSKEY) is the older, WebKit-safe signal for the same thing: Safari fires the confirming Enter keydown AFTER
// compositionend, when `isComposing` is already false (WebKit bug 165004).
export function isImeKey(event) {
  return Boolean(event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229);
}
