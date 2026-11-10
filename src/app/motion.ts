/**
 * Small board animations, done with the Web Animations API (no style attributes in HTML, so the CSP stays happy).
 * Everything here is skipped when the person asked for reduced motion.
 *
 * - `leave(el)`: the element shrinks and fades away; resolves when it is done, so the caller removes it from state then.
 * - `markEnter(key)` + `useEnter(key, ref)`: an element that comes BACK (undo, a failed archive) grows in instead of popping.
 *   New cards and lists (still saving) animate from CSS (`[data-pending]`, in `boards/polish.css`).
 */
import {type RefObject, useLayoutEffect} from 'react';

const LEAVE_MS = 180;
const ENTER_MS = 200;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

const reduced = () => typeof window === 'undefined' || !('animate' in Element.prototype) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The gap between this element and its siblings along the list's direction (px), so collapsing it closes the gap too. */
function gapOf(el: HTMLElement, axis: 'block' | 'inline'): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  const style = getComputedStyle(parent);
  return parseFloat(axis === 'block' ? style.rowGap : style.columnGap) || 0;
}

/**
 * Shrink and fade `el` out along its list's axis (cards: `block`, lists: `inline`). The element stays hidden at the end
 * (the caller removes it from state); if it is still on the page shortly after (the action did nothing), it comes back.
 */
export function leave(el: Element | null | undefined, axis: 'block' | 'inline' = 'block'): Promise<void> {
  if (!(el instanceof HTMLElement) || reduced() || !el.isConnected) return Promise.resolve();
  const size = axis === 'block' ? el.offsetHeight : el.offsetWidth;
  const gap = gapOf(el, axis);
  const from: Keyframe =
    axis === 'block'
      ? {opacity: 1, transform: 'scale(1)', height: `${size}px`, marginBlockEnd: '0px'}
      : {opacity: 1, transform: 'scale(1)', width: `${size}px`, minWidth: `${size}px`, flexBasis: `${size}px`, marginInlineEnd: '0px'};
  const to: Keyframe =
    axis === 'block'
      ? {opacity: 0, transform: 'scale(0.96)', height: '0px', paddingBlock: '0px', borderWidth: '0px', marginBlockEnd: `${-gap}px`}
      : {opacity: 0, transform: 'scale(0.96)', width: '0px', minWidth: '0px', flexBasis: '0px', paddingInline: '0px', borderWidth: '0px', marginInlineEnd: `${-gap}px`};
  el.style.overflow = 'hidden';
  el.style.pointerEvents = 'none';
  const anim = el.animate([from, to], {duration: LEAVE_MS, easing: EASE, fill: 'forwards'});
  const restore = () => {
    anim.cancel();
    el.style.overflow = '';
    el.style.pointerEvents = '';
  };
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
      // Removed by the action: nothing to undo. Still here (the action did nothing, or failed at once): show it again.
      window.setTimeout(() => {
        if (el.isConnected) restore();
      }, 120);
    };
    anim.finished.then(done, done);
    // A tab in the background may never finish the animation: never block the action on it.
    window.setTimeout(done, LEAVE_MS + 80);
  });
}

/** `leave` for every element matching `selector` inside `root`, together. */
export function leaveAll(root: ParentNode | null | undefined, selector: string, axis: 'block' | 'inline' = 'block'): Promise<void> {
  if (!root) return Promise.resolve();
  return Promise.all([...root.querySelectorAll(selector)].map(el => leave(el, axis))).then(() => undefined);
}

/** Keys (`card-12`, `lane-3`) that should grow in the next time they mount. Short-lived: cleared on mount. */
const entering = new Set<string>();

export function markEnter(key: string) {
  entering.add(key);
  // Never kept for long: a key whose element does not mount soon (filtered out, other board) is forgotten.
  window.setTimeout(() => entering.delete(key), 2000);
}

/** On mount, grow the element in if `key` was marked (an undo or a rollback brought it back). */
export function useEnter(key: string, ref: RefObject<HTMLElement | null>, axis: 'block' | 'inline' = 'block') {
  useLayoutEffect(() => {
    if (!entering.delete(key)) return;
    const el = ref.current;
    if (!el || reduced()) return;
    const size = axis === 'block' ? el.offsetHeight : el.offsetWidth;
    const from: Keyframe =
      axis === 'block'
        ? {opacity: 0, transform: 'scale(0.96)', height: '0px', overflow: 'hidden'}
        : {opacity: 0, transform: 'scale(0.96)', width: '0px', minWidth: '0px', flexBasis: '0px', overflow: 'hidden'};
    const to: Keyframe =
      axis === 'block'
        ? {opacity: 1, transform: 'scale(1)', height: `${size}px`, overflow: 'hidden'}
        : {opacity: 1, transform: 'scale(1)', width: `${size}px`, minWidth: `${size}px`, flexBasis: `${size}px`, overflow: 'hidden'};
    el.animate([from, to], {duration: ENTER_MS, easing: EASE});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
