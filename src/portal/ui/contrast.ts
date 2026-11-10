/**
 * Pure colour helpers for the kit (no DOM, no React): strict `#rrggbb`
 * validation and WCAG contrast. Hex values are DATA here (user-chosen label
 * colours), never theme colours: the theme itself stays in CSS tokens.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

/** True only for a full `#rrggbb` string: no short form, no alpha, no names, nothing else. */
export function isValidHex(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** `#AABBCC` becomes `#aabbcc`. Returns null for anything that is not `#rrggbb`. */
export function normalizeHex(value: unknown): string | null {
  return isValidHex(value) ? value.toLowerCase() : null;
}

export function hexToRgb(hex: string): [number, number, number] {
  if (!isValidHex(hex)) throw new RangeError(`Not a #rrggbb colour: ${String(hex)}`);
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(channel => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21 (order does not matter). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const BLACK = '#000000';
export const WHITE = '#ffffff';

/** White text is used once it reaches this contrast (WCAG AA for bold label text); below it, black. */
const WHITE_MIN_CONTRAST = 3;

/**
 * The text colour (`#000000` or `#ffffff`) for a label on `bg`: white on dark and saturated mid-tones
 * (red, blue, purple, pink), black on light ones (yellow, orange, green). Invalid input gets black.
 */
export function readableOn(bg: string): '#000000' | '#ffffff' {
  if (!isValidHex(bg)) return BLACK;
  return contrastRatio(bg, WHITE) >= WHITE_MIN_CONTRAST ? WHITE : BLACK;
}

/** Default swatches of the `ColorPicker` (label colours). */
export const COLOR_PRESETS: readonly string[] = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#64748b',
];
