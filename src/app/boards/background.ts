/**
 * A board's background, set on the element through `element.style` (the CSP allows the CSSOM, never a
 * `style=""` attribute). Colours were checked as strict `#rrggbb` by the server; the angle is a number; a
 * photo is only ever our own `/site-api/boards/:id/background` address (checked here, so nothing else can
 * reach the CSS). Used as a ref callback, so it runs whenever the element or the board's background changes.
 */
export type Background = {bgKind: string; bgColor1: string; bgColor2: string; bgAngle: number; bgPattern?: string; bgImage?: string | null};

/**
 * The database default for a board with no chosen colour (`boards.bg_color_1`). It is near white, which is
 * a glaring slab in the dark theme, so the default sets nothing and the theme's own surface colour shows.
 */
const DEFAULT_SOLID = '#f4f4f5';
const IMAGE_URL = /^\/site-api\/boards\/\d{1,12}\/background\?v=[a-z0-9]{1,16}$/;

/** The photo's address when it is safe to put in CSS, else null. */
export const safeImageUrl = (url: string | null | undefined): string | null => (url && IMAGE_URL.test(url) ? url : null);

export function backgroundStyle(node: HTMLElement | null, board: Background) {
  if (!node) return;
  const hex = /^#[0-9a-fA-F]{6}$/;
  const one = hex.test(board.bgColor1) ? board.bgColor1 : '';
  const two = hex.test(board.bgColor2) ? board.bgColor2 : one;
  const angle = Number.isFinite(board.bgAngle) ? Math.max(0, Math.min(360, Math.round(board.bgAngle))) : 0;
  const image = board.bgKind === 'image' ? safeImageUrl(board.bgImage) : null;
  if (image) {
    // The colour shows while the photo loads (and if it cannot), except the near-white default.
    const under = one && one.toLowerCase() !== DEFAULT_SOLID ? ` ${one}` : '';
    node.style.background = `url("${image}") center / cover no-repeat${under}`;
    return;
  }
  if (board.bgKind !== 'gradient' && one.toLowerCase() === DEFAULT_SOLID) {
    node.style.background = '';
    return;
  }
  node.style.background = board.bgKind === 'gradient' && one ? `linear-gradient(${angle}deg, ${one}, ${two})` : one;
}
