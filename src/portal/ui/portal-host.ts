import {useSyncExternalStore} from 'react';

/**
 * Where a floating layer (toast, undo bar, menu) must render so it is SEEN and CLICKABLE: a modal `<dialog>` sits in the
 * browser's top layer and makes everything outside it inert, so anything left in the body is hidden and dead while one is
 * open. The host is the top-most open modal dialog (the last one shown), else `document.body`.
 */

/** Pure: keep the order dialogs were opened in. Closed ones drop out, newly open ones go on top. */
export function nextDialogStack<T>(previous: readonly T[], openNow: readonly T[]): T[] {
  const kept = previous.filter(item => openNow.includes(item));
  return [...kept, ...openNow.filter(item => !kept.includes(item))];
}

/** Pure: the host for a layer: the top-most dialog of the stack, or the fallback. */
export function pickHost<T, F>(stack: readonly T[], fallback: F): T | F {
  return stack.length ? stack[stack.length - 1]! : fallback;
}

/** The nearest open dialog around `el`, else the body (for a layer opened from a known trigger). */
export function portalHost(el: Element | null | undefined): HTMLElement {
  return (el?.closest('dialog[open]') as HTMLElement | null) ?? document.body;
}

let stack: HTMLDialogElement[] = [];
let started = false;
const listeners = new Set<() => void>();

function refresh() {
  const openNow = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(d => d.matches(':modal'));
  const next = nextDialogStack(stack, openNow);
  if (next.length === stack.length && next.every((d, i) => d === stack[i])) return;
  stack = next;
  listeners.forEach(fn => fn());
}

function subscribe(fn: () => void) {
  if (!started && typeof document !== 'undefined') {
    started = true;
    // `open` flips on showModal()/close(); dialogs come and go as React mounts them.
    new MutationObserver(refresh).observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['open']});
    refresh();
  }
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const snapshot = (): HTMLElement | null => (stack.length ? stack[stack.length - 1]! : null);

/** The element to portal a floating layer into: the top-most open modal dialog, or `document.body`. */
export function useOverlayHost(): HTMLElement | null {
  const top = useSyncExternalStore(subscribe, snapshot, () => null);
  return top ?? (typeof document === 'undefined' ? null : document.body);
}
