// Player configuration: what the video player shows and allows, set in layers
// (platform → school → course → lesson → learner) and resolved into one
// PlayerConfig before it reaches the player. The player never reads storage.

export type PlayerConfig = {
  // Controls shown.
  playButton: boolean;
  seekBar: boolean;
  timeDisplay: boolean;
  volumeControl: boolean;
  speedControl: boolean;
  captionsControl: boolean;
  pipButton: boolean;
  fullscreenButton: boolean;
  keyboardShortcuts: boolean;
  // Behaviour.
  allowSeekAhead: boolean; // false: no seeking past the furthest point played
  playbackRates: readonly number[]; // the speeds offered; one value fixes the speed
  playbackRate: number;
  autoplay: boolean;
  resumePosition: boolean; // start where the learner left off
  captionsOn: boolean;
  captionLanguage: string | null; // BCP 47; null: the track marked default
  volume: number; // 0–1
  muted: boolean;
  skipSeconds: number; // back/forward buttons by this many seconds (0: none; a skipSeconds prop wins)
  loop: boolean;
  // Look.
  accentColor: string | null; // #rgb or #rrggbb; null: the design's action colour
  skin: PlayerSkin; // the root's data-skin
  controlBar: 'auto' | PlayerBar; // data-bar; auto: the skin's (skinBar)
  bigPlayButton: 'auto' | 'none' | 'circle' | 'rounded' | 'square'; // the centre play button while paused; auto: the skin's shape
  barColor: string | null; // the bar's background (--player-bar); null: the skin's
  iconColor: string | null; // icons and time (--player-icon); null: the skin's
  cornerRadius: number; // px, 0–32 (--player-radius)
  iconSize: 'sm' | 'md' | 'lg'; // data-icons
  autoHide: boolean; // controls hide while playing; false: always shown (data-autohide="off")
  // Over the video.
  logo: PlayerLogo;
  watermark: PlayerWatermark;
  endScreen: PlayerEndScreen;
  protection: PlayerProtection;
};

export const playerSkins = [
  'studio',
  'classic',
  'minimal',
  'dark',
  'glass',
  'rounded',
  'bold',
] as const;
export type PlayerSkin = (typeof playerSkins)[number];

export type PlayerBar = 'overlay' | 'floating' | 'solid';

// skinBar is each skin's own control bar (controlBar 'auto').
export const skinBar: Record<PlayerSkin, PlayerBar> = {
  studio: 'floating',
  classic: 'overlay',
  minimal: 'overlay',
  dark: 'solid', // a solid band under the video
  glass: 'floating',
  rounded: 'overlay',
  bold: 'overlay',
};

// barOf is the control bar the player shows.
export const barOf = (config: Pick<PlayerConfig, 'skin' | 'controlBar'>): PlayerBar =>
  config.controlBar === 'auto' ? skinBar[config.skin] : config.controlBar;

export type PlayerCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

// PlayerLogo is the school's logo over the video.
export type PlayerLogo = {
  enabled: boolean;
  url: string; // http(s) image
  position: PlayerCorner;
  size: number; // % of the video's width, 4–40
  opacity: number; // 0.1–1
  link: string; // http(s); '' = none
};

// PlayerWatermark is text over the video. Tokens {name} {email} {userId}
// {date} {time} {school} are filled from the watermarkViewer prop.
export type PlayerWatermark = {
  enabled: boolean;
  text: string;
  position: 'center' | PlayerCorner;
  opacity: number; // 0.05–1
  fontSize: number; // px, 10–48
  color: string | null; // null: white
  tiled: boolean; // repeated across the video
  animation: 'none' | 'drift' | 'bounce' | 'jump' | 'fade';
  intervalSeconds: number; // jump and fade: how often it moves, 2–300
};

// PlayerEndScreen shows when the video ends.
export type PlayerEndScreen = {
  enabled: boolean;
  title: string;
  text: string;
  buttonLabel: string;
  buttonUrl: string; // http(s); '' = no button
  showReplay: boolean;
};

// PlayerProtection makes copying harder for honest browsers (DRM protects the bytes).
export type PlayerProtection = {
  disableContextMenu: boolean;
  pauseWhenHidden: boolean; // pauses when the tab or window is left
  blurOnCapture: boolean; // blurs the video on screenshot keys
};

export type PlayerConfigKey = keyof PlayerConfig;

export type PlayerConfigLayer = {
  values?: Partial<PlayerConfig>;
  // Fields no later layer may change. A lock is final: nothing unlocks it.
  locks?: readonly PlayerConfigKey[];
};

export type PlayerConfigLayers = {
  school?: PlayerConfigLayer;
  course?: PlayerConfigLayer;
  lesson?: PlayerConfigLayer;
  learner?: Pick<PlayerConfigLayer, 'values'>; // preferences, never locks
};

export type ResolvedPlayerConfig = {
  config: PlayerConfig;
  locked: ReadonlySet<PlayerConfigKey>;
};

export const defaultPlayerConfig: PlayerConfig = {
  playButton: true,
  seekBar: true,
  timeDisplay: true,
  volumeControl: true,
  speedControl: true,
  captionsControl: true,
  pipButton: true,
  fullscreenButton: true,
  keyboardShortcuts: true,
  allowSeekAhead: true,
  playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  playbackRate: 1,
  autoplay: false,
  resumePosition: true,
  captionsOn: false,
  captionLanguage: null,
  volume: 1,
  muted: false,
  skipSeconds: 0,
  loop: false,
  accentColor: null,
  skin: 'studio',
  controlBar: 'auto',
  bigPlayButton: 'auto',
  barColor: null,
  iconColor: null,
  cornerRadius: 10,
  iconSize: 'md',
  autoHide: true,
  logo: {enabled: false, url: '', position: 'top-right', size: 12, opacity: 0.8, link: ''},
  watermark: {
    enabled: false,
    text: '',
    position: 'bottom-right',
    opacity: 0.35,
    fontSize: 14,
    color: null,
    tiled: false,
    animation: 'none',
    intervalSeconds: 10,
  },
  endScreen: {
    enabled: false,
    title: '',
    text: '',
    buttonLabel: '',
    buttonUrl: '',
    showReplay: true,
  },
  protection: {disableContextMenu: false, pauseWhenHidden: false, blurOnCapture: false},
};

// The fields a learner's own preferences may set, when no layer locked them.
export const learnerPreferenceKeys = [
  'playbackRate',
  'captionsOn',
  'captionLanguage',
  'volume',
  'muted',
  'autoplay',
] as const satisfies readonly PlayerConfigKey[];

const order = ['school', 'course', 'lesson', 'learner'] as const;
const playerConfigKeys = Object.keys(defaultPlayerConfig) as PlayerConfigKey[];

// resolvePlayerConfig applies the layers over the platform defaults in order.
// A field takes the last valid value set before a layer locked it; invalid
// values (a rate of 0, an accent that isn't a colour) are skipped.
export function resolvePlayerConfig(layers: PlayerConfigLayers): ResolvedPlayerConfig {
  const config: PlayerConfig = {...defaultPlayerConfig};
  const locked = new Set<PlayerConfigKey>();
  for (const name of order) {
    const layer = layers[name];
    if (!layer) continue;
    const keys: readonly PlayerConfigKey[] =
      name === 'learner' ? learnerPreferenceKeys : playerConfigKeys;
    for (const key of keys) {
      const value = layer.values?.[key];
      if (value === undefined || locked.has(key)) continue;
      const clean = sanitize(key, value);
      if (clean !== undefined) Object.assign(config, {[key]: clean});
    }
    if (name !== 'learner') {
      for (const key of (layer as PlayerConfigLayer).locks ?? []) locked.add(key);
    }
  }
  // The speed must be one the menu offers.
  if (!config.playbackRates.includes(config.playbackRate)) {
    config.playbackRate = nearest(config.playbackRates, config.playbackRate);
  }
  return {config, locked};
}

// nearest is the allowed rate closest to rate.
export function nearest(rates: readonly number[], rate: number): number {
  return rates.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best));
}

const hexColour = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const languageTag = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const validRate = (r: unknown) => typeof r === 'number' && r >= 0.25 && r <= 4;

// webUrl: '' or an http(s) link (never javascript: and the like).
const webUrl = (v: unknown) => {
  if (typeof v !== 'string' || v === '') return v === '';
  try {
    const {protocol} = new URL(v);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};
const between = (lo: number, hi: number) => (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const oneOf =
  (...values: readonly string[]) =>
  (v: unknown) =>
    typeof v === 'string' && values.includes(v);
const colour = (v: unknown) => v === null || (typeof v === 'string' && hexColour.test(v));
const text = (max: number) => (v: unknown) => typeof v === 'string' && v.length <= max;
const bool = (v: unknown) => typeof v === 'boolean';
const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

type Rules<T> = {[K in keyof T]: (v: unknown) => boolean};

const objectRules: {
  logo: Rules<PlayerLogo>;
  watermark: Rules<PlayerWatermark>;
  endScreen: Rules<PlayerEndScreen>;
  protection: Rules<PlayerProtection>;
} = {
  logo: {
    enabled: bool,
    url: (v) => webUrl(v) && text(2048)(v),
    position: oneOf(...corners),
    size: between(4, 40),
    opacity: between(0.1, 1),
    link: (v) => webUrl(v) && text(2048)(v),
  },
  watermark: {
    enabled: bool,
    text: text(200),
    position: oneOf('center', ...corners),
    opacity: between(0.05, 1),
    fontSize: between(10, 48),
    color: colour,
    tiled: bool,
    animation: oneOf('none', 'drift', 'bounce', 'jump', 'fade'),
    intervalSeconds: between(2, 300),
  },
  endScreen: {
    enabled: bool,
    title: text(120),
    text: text(300),
    buttonLabel: text(40),
    buttonUrl: (v) => webUrl(v) && text(2048)(v),
    showReplay: bool,
  },
  protection: {disableContextMenu: bool, pauseWhenHidden: bool, blurOnCapture: bool},
};

// sanitizeObject keeps the valid fields of value over the defaults: one bad
// field doesn't drop the rest.
function sanitizeObject<T extends object>(
  rules: Rules<T>,
  fallback: T,
  value: unknown,
): T | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out = {...fallback};
  for (const k of Object.keys(rules) as (keyof T)[]) {
    const v = (value as Record<keyof T, unknown>)[k];
    if (v !== undefined && rules[k](v)) out[k] = v as T[keyof T];
  }
  return out;
}

// sanitize returns value when it is valid for key, else undefined. Layers come
// from storage and the accent ends up in CSS, so nothing is trusted.
function sanitize(key: PlayerConfigKey, value: unknown): unknown {
  const expected = typeof defaultPlayerConfig[key];
  switch (key) {
    case 'logo':
    case 'watermark':
    case 'endScreen':
    case 'protection':
      return sanitizeObject<object>(
        objectRules[key] as Rules<object>,
        defaultPlayerConfig[key] as object,
        value,
      );
    case 'skin': {
      // Saved configs from before the rename still say 'cinema': it is 'dark' now.
      const skin = value === 'cinema' ? 'dark' : value;
      return oneOf(...playerSkins)(skin) ? skin : undefined;
    }
    case 'controlBar':
      return oneOf('auto', 'overlay', 'floating', 'solid')(value) ? value : undefined;
    case 'bigPlayButton':
      return oneOf('auto', 'none', 'circle', 'rounded', 'square')(value) ? value : undefined;
    case 'iconSize':
      return oneOf('sm', 'md', 'lg')(value) ? value : undefined;
    case 'barColor':
    case 'iconColor':
      return colour(value) ? value : undefined;
    case 'cornerRadius':
      return between(0, 32)(value) ? value : undefined;
    case 'skipSeconds':
      return [0, 5, 10, 15, 30].includes(value as number) ? value : undefined;
    case 'playbackRates': {
      if (!Array.isArray(value) || value.length === 0 || !value.every(validRate)) return undefined;
      return [...new Set(value as number[])];
    }
    case 'playbackRate':
      return validRate(value) ? value : undefined;
    case 'volume':
      return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined;
    case 'accentColor':
      return value === null || (typeof value === 'string' && hexColour.test(value))
        ? value
        : undefined;
    case 'captionLanguage':
      return value === null || (typeof value === 'string' && languageTag.test(value))
        ? value
        : undefined;
    default:
      return typeof value === expected ? value : undefined;
  }
}
