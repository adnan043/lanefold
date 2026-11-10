import './settings.css';
import './accents.css';

import {customAccentCss} from '../../lib/brand';
import {normalizeHex} from '../../portal/ui/contrast';

/**
 * This device's look, applied as attributes on <html> so CSS does the work:
 * mode (`data-theme`: light | dark | contrast, absent = the device), density, accent (`data-accent`, absent =
 * `brand`: the site's brand colour the admin sets in /dashboard Branding, served by /site-api/brand.css), text size (`data-font`) and motion (`data-motion`, honoured by a11y.css).
 * Everything is kept in this browser (localStorage) and applied at boot by AppRoot, before the first paint.
 * Mode, density, text size, corner radius and motion are also saved to the signed-in user's profile (`GET / PATCH /preferences`, see
 * `usePreferences` in sync.ts); locale lives in the `lf_locale` cookie and the profile too.
 */
export type ThemeMode = 'system' | 'light' | 'dark' | 'contrast';
export type Density = 'compact' | 'comfortable' | 'spacious';
/** `brand` = no personal accent: the site's brand colour (the default). */
export const ACCENTS = ['brand', 'green', 'teal', 'blue', 'indigo', 'purple', 'rose', 'orange', 'slate'] as const;
/** A preset, or `custom`: the person's own `#rrggbb` (kept under `lf:accent-custom`). */
export type Accent = (typeof ACCENTS)[number] | 'custom';
export const FONT_SCALES = ['100', '112', '125', '150'] as const;
export type FontScale = (typeof FONT_SCALES)[number];
export const RADII = ['sharp', 'soft', 'round'] as const;
export type Radius = (typeof RADII)[number];

const THEME_KEY = 'lf:theme';
/** The key the dashboard and the app layout read before first paint: light or dark only. */
const SITE_THEME_KEY = 'site:theme';
const DENSITY_KEY = 'lf:density';
const ACCENT_KEY = 'lf:accent';
const CUSTOM_ACCENT_KEY = 'lf:accent-custom';
const FONT_KEY = 'lf:font';
const RADIUS_KEY = 'lf:radius';
const MOTION_KEY = 'lf:motion';
const SHORTCUTS_KEY = 'lf:shortcuts';

export const THEMES: readonly ThemeMode[] = ['light', 'dark', 'system', 'contrast'];
export const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'spacious'];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts until the tab closes.
  }
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}
export function isDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

export function storedTheme(): ThemeMode {
  const value = read(THEME_KEY) ?? read(SITE_THEME_KEY);
  return isThemeMode(value) ? value : 'system';
}

export function storedDensity(): Density {
  const value = read(DENSITY_KEY);
  return value === 'compact' || value === 'spacious' ? value : 'comfortable';
}

export function storedAccent(): Accent {
  const value = read(ACCENT_KEY);
  if (value === 'custom') return storedCustomAccent() ? 'custom' : 'brand';
  return (ACCENTS as readonly string[]).includes(value ?? '') ? (value as Accent) : 'brand';
}

/** The person's own accent colour (`#rrggbb`), kept even while a preset is picked; null when never set. */
export function storedCustomAccent(): string | null {
  return normalizeHex(read(CUSTOM_ACCENT_KEY));
}

/**
 * The custom accent's tokens, as a constructed stylesheet (CSSOM: allowed by the CSP, unlike a <style> tag or
 * a style attribute). One sheet per tab, replaced on each change.
 */
let customSheet: CSSStyleSheet | null = null;
function setCustomSheet(hex: string) {
  try {
    if (!customSheet) {
      customSheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, customSheet];
    }
    customSheet.replaceSync(customAccentCss(hex));
  } catch {
    // Constructable stylesheets unsupported: the site's brand colour stays.
  }
}

export function storedFontScale(): FontScale {
  const value = read(FONT_KEY);
  return (FONT_SCALES as readonly string[]).includes(value ?? '') ? (value as FontScale) : '100';
}

export function isRadius(value: unknown): value is Radius {
  return typeof value === 'string' && (RADII as readonly string[]).includes(value);
}
export function isFontScale(value: unknown): value is FontScale {
  return typeof value === 'string' && (FONT_SCALES as readonly string[]).includes(value);
}

export function storedRadius(): Radius {
  const value = read(RADIUS_KEY);
  return isRadius(value) ? value : 'soft';
}

export function applyRadius(radius: Radius) {
  const root = document.documentElement;
  if (radius === 'soft') delete root.dataset.radius;
  else root.dataset.radius = radius;
  write(RADIUS_KEY, radius === 'soft' ? null : radius);
}

/** True when the person turned motion off here (the device's own setting is handled by the media query). */
export function storedReduceMotion(): boolean {
  return read(MOTION_KEY) === 'reduce';
}

/** Single-key shortcuts (`/`, `n`, `?`, `g` + letter): on unless the person turned them off here. Read at event time. */
export function storedShortcuts(): boolean {
  return read(SHORTCUTS_KEY) !== 'off';
}

export function applyShortcuts(on: boolean) {
  write(SHORTCUTS_KEY, on ? null : 'off');
}

export function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  write(THEME_KEY, theme === 'system' ? null : theme);
  write(SITE_THEME_KEY, theme === 'light' || theme === 'dark' ? theme : null);
}

export function applyDensity(density: Density) {
  document.documentElement.dataset.density = density;
  write(DENSITY_KEY, density === 'comfortable' ? null : density);
}

/** Picks the person's own colour: any `#rrggbb`, made readable in light and dark (lib/brand.ts). */
export function applyCustomAccent(value: string) {
  const hex = normalizeHex(value);
  if (!hex) return;
  setCustomSheet(hex);
  document.documentElement.dataset.accent = 'custom';
  write(CUSTOM_ACCENT_KEY, hex);
  write(ACCENT_KEY, 'custom');
}

export function applyAccent(accent: Accent) {
  const root = document.documentElement;
  if (accent === 'custom') {
    const hex = storedCustomAccent();
    if (hex) applyCustomAccent(hex);
    return;
  }
  if (accent === 'brand') delete root.dataset.accent;
  else root.dataset.accent = accent;
  write(ACCENT_KEY, accent === 'brand' ? null : accent);
}

export function applyFontScale(scale: FontScale) {
  const root = document.documentElement;
  if (scale === '100') delete root.dataset.font;
  else root.dataset.font = scale;
  write(FONT_KEY, scale === '100' ? null : scale);
}

export function applyReduceMotion(reduce: boolean) {
  const root = document.documentElement;
  if (reduce) root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
  write(MOTION_KEY, reduce ? 'reduce' : null);
}

/** Boot: everything from this browser, before React draws (AppRoot calls it at import time). */
export function applyStoredPrefs() {
  const root = document.documentElement;
  const theme = storedTheme();
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.dataset.density = storedDensity();
  const accent = storedAccent();
  // The custom sheet is scoped to data-accent='custom', so it is loaded whenever a colour is kept: the swatch shows it.
  const custom = storedCustomAccent();
  if (custom) setCustomSheet(custom);
  if (accent !== 'brand') root.dataset.accent = accent;
  const font = storedFontScale();
  if (font !== '100') root.dataset.font = font;
  const radius = storedRadius();
  if (radius !== 'soft') root.dataset.radius = radius;
  if (storedReduceMotion()) root.dataset.motion = 'reduce';
}
