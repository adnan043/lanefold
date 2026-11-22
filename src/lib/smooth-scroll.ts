/**
 * Smooth (eased) mouse-wheel scrolling for the marketing pages: a page opts in with
 * `<Base smoothScroll>` (`<html data-smooth-scroll>`). No library: the wheel moves a
 * target position and each frame eases the page toward it.
 *
 * Left to the browser (native): keyboard, scrollbar, touch, pinch / ctrl+wheel zoom,
 * horizontal wheels, a nested scroll box that can still scroll, a locked page
 * (`overflow: hidden`, an open menu or dialog), and reduced motion (the device setting
 * or `html[data-motion='reduce']`).
 *
 * With the ClientRouter: `syncSmoothScroll()` runs on every `astro:page-load` and
 * `stopSmoothScroll()` on `astro:before-swap`, so it follows the page it is on.
 */

const EASE = 0.12; // share of the remaining distance covered per 60 fps frame
const LINE = 40; // px per wheel "line" (Firefox `deltaMode` 1)

let running = false;
let target = 0;
let current = 0;
let frame = 0;
let lastTime = 0;

const reducedMotion = () =>
  document.documentElement.dataset.motion === 'reduce' ||
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;

const pageLocked = () => {
  const html = getComputedStyle(document.documentElement).overflowY;
  const body = getComputedStyle(document.body).overflowY;
  return html === 'hidden' || body === 'hidden';
};

/** A scroll box between the pointer and the page that can still move in this direction. */
const nestedCanScroll = (start: EventTarget | null, dy: number) => {
  for (let el = start instanceof Element ? start : null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  return false;
};

const tick = (time: number) => {
  const elapsed = lastTime ? Math.min(time - lastTime, 64) : 16.7;
  lastTime = time;
  // The same easing at any refresh rate.
  const step = 1 - Math.pow(1 - EASE, elapsed / 16.7);
  current += (target - current) * step;
  if (Math.abs(target - current) < 0.5) current = target;
  // Whole device pixels only: fractional offsets make the sticky header and bars shimmer.
  const dpr = window.devicePixelRatio || 1;
  window.scrollTo({top: Math.round(current * dpr) / dpr, behavior: 'instant'});
  frame = current === target ? 0 : requestAnimationFrame(tick);
  if (!frame) lastTime = 0;
};

const onWheel = (event: WheelEvent) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  if (reducedMotion() || pageLocked()) return;
  const dy = event.deltaY * (event.deltaMode === 1 ? LINE : event.deltaMode === 2 ? window.innerHeight : 1);
  if (!dy || nestedCanScroll(event.target, dy)) return;

  event.preventDefault();
  // Starting fresh: begin from where the page really is (keys or the scrollbar may have moved it).
  if (!frame) current = target = window.scrollY;
  target = Math.max(0, Math.min(maxScroll(), target + dy));
  if (!frame) frame = requestAnimationFrame(tick);
};

/** Anything else moved the page (keys, scrollbar, an anchor): follow it. */
const onScroll = () => {
  if (!frame) current = target = window.scrollY;
};

/** An in-page anchor or a link click mid-glide: stop gliding so the jump wins. */
const cancel = () => {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  lastTime = 0;
  current = target = window.scrollY;
};

export function stopSmoothScroll() {
  if (!running) return;
  running = false;
  cancel();
  window.removeEventListener('wheel', onWheel);
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('keydown', cancel);
  document.removeEventListener('click', cancel);
}

export function syncSmoothScroll() {
  const wanted = document.documentElement.hasAttribute('data-smooth-scroll');
  if (!wanted) return stopSmoothScroll();
  if (running) return cancel();
  running = true;
  current = target = window.scrollY;
  window.addEventListener('wheel', onWheel, {passive: false});
  window.addEventListener('scroll', onScroll, {passive: true});
  window.addEventListener('keydown', cancel);
  document.addEventListener('click', cancel);
}
