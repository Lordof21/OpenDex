// Focus management for a modal card: focus moves in when it opens, Tab/Shift+Tab stay inside, and focus returns to where it came
// from when it closes. `aria-modal="true"` promises exactly this to assistive technology (WCAG 2.4.3); the element does not do it
// by itself.
//
// Deliberately not `inert` on the page: a Dialog may be `position="absolute"` inside a window (files/*), where only that window is
// modal — a document-wide inert would freeze the rest of the desktop. Tab is contained in the card instead.
import { useEffect } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// No layout test (offsetParent / getClientRects): jsdom has no layout, so every element would count as hidden there.
const focusablesIn = (card) => [...card.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden], [aria-hidden="true"]'));

export function useModalFocus(open, cardRef) {
  useEffect(() => {
    const card = cardRef.current;
    if (!open || !card) return undefined;

    const opener = document.activeElement;
    // A consumer's own `autoFocus` (a "Cancel" button, a name field) already moved focus inside: keep it.
    if (!card.contains(document.activeElement)) (focusablesIn(card)[0] || card).focus({ preventScroll: true });

    const onKeyDown = (event) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const active = document.activeElement;
      const nowhere = !active || active === document.body;
      if (!nowhere && !card.contains(active)) return;                 // focus is in another layer (a menu on top of this dialog): not ours
      const items = focusablesIn(card);
      if (!items.length) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (nowhere) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, cardRef]);
}
