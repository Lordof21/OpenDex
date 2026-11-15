// Arrow-key navigation for a container of `role="menuitem"` / `role="tab"` children (WAI-ARIA Authoring Practices): ↑↓ (or ←→) move
// focus between the items, Home/End jump to the first/last, and the ends wrap. A role is a promise about keyboard behaviour; without
// this a `role="menu"` is a list of buttons the keyboard can only Tab through.
//
//   <div role="menu" onKeyDown={(e) => rovingKeys(e, '[role="menuitem"]')}>
//
// `orientation`: 'vertical' (↑↓, default), 'horizontal' (←→) or 'both' (a two-dimensional grid of items: any arrow steps through the
// DOM order). Returns true when it handled the key (the caller can then skip its own handling).
import { isImeKey } from '../lib/ime.js';

const STEP = {
  vertical: { ArrowDown: 1, ArrowUp: -1 },
  horizontal: { ArrowRight: 1, ArrowLeft: -1 },
  both: { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 },
};

export function rovingKeys(event, selector, { orientation = 'vertical' } = {}) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isImeKey(event)) return false;
  const step = STEP[orientation][event.key];
  const edge = event.key === 'Home' || event.key === 'End';
  if (!step && !edge) return false;

  const items = [...event.currentTarget.querySelectorAll(selector)].filter((el) => !el.disabled && !el.closest('[hidden]'));
  if (!items.length) return false;

  const at = items.indexOf(document.activeElement);
  let to;
  if (event.key === 'Home') to = 0;
  else if (event.key === 'End') to = items.length - 1;
  else if (at < 0) to = step > 0 ? 0 : items.length - 1;                  // focus is on the container itself: enter from the matching end
  else to = (at + step + items.length) % items.length;

  event.preventDefault();
  items[to].focus();
  return true;
}
