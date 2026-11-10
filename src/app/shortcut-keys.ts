/**
 * The letter a key press stands for. The produced character (`event.key`) wins, so Dvorak / Colemak users get the
 * letter printed on their key; only when the key is not a Latin letter (Arabic, Cyrillic, Hebrew layouts) does the
 * physical position (`event.code`) stand in. '' for anything else.
 */
export function letterOf(event: Pick<KeyboardEvent, 'code' | 'key'>): string {
  const key = event.key.length === 1 ? event.key.toLowerCase() : '';
  if (/^[a-z]$/.test(key)) return key;
  if (key === '/') return '/';
  if (key !== '' && /^[\p{L}]$/u.test(key) && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return '';
}

/** Ctrl/Cmd+K: by the produced letter first, by the physical key only on non-Latin layouts. */
export function isPaletteKey(event: Pick<KeyboardEvent, 'code' | 'key'>): boolean {
  return letterOf(event) === 'k';
}
