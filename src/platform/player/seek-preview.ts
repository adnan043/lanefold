// Seek-bar preview frames from a video host's sprite sheets (Bunny Stream:
// {video}/seek/_{n}.jpg, a grid of frames, one every intervalSec). Pure: the
// skin and any page that shows a frame (a moment's thumbnail) use it.

export type SeekPreview = {
  src: string; // a sheet's URL with the literal "{i}" for its number (0-based)
  intervalSec: number; // one frame every this many seconds
  columns: number;
  rows: number;
  frameWidth: number; // px in the sheet
  frameHeight: number;
  frames: number; // frames in all, across the sheets
};

export type SeekFrame = {
  url: string; // the sheet holding the frame
  x: number; // the frame's place in the sheet, px
  y: number;
  width: number; // the frame's size, px
  height: number;
  sheetWidth: number; // the sheet's width, px (columns × frameWidth)
};

const whole = (n: unknown, min: number) =>
  typeof n === 'number' && Number.isFinite(n) && n >= min ? n : 0;

// seekPreviewOf is p when it can show frames, else undefined.
export function seekPreviewOf(p: unknown): SeekPreview | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const s = p as Partial<SeekPreview>;
  const ok =
    typeof s.src === 'string' &&
    s.src.includes('{i}') &&
    whole(s.intervalSec, 0.001) &&
    whole(s.columns, 1) &&
    whole(s.rows, 1) &&
    whole(s.frameWidth, 1) &&
    whole(s.frameHeight, 1) &&
    whole(s.frames, 1);
  return ok ? (s as SeekPreview) : undefined;
}

// seekFrame is the frame at second t: the last one taken at or before it,
// clamped to the video's frames.
export function seekFrame(p: SeekPreview, t: number): SeekFrame {
  const per = Math.floor(p.columns) * Math.floor(p.rows);
  const k = Math.min(Math.max(Math.floor((Number(t) || 0) / p.intervalSec), 0), p.frames - 1);
  const sheet = Math.floor(k / per);
  const cell = k % per;
  return {
    url: p.src.replaceAll('{i}', String(sheet)),
    x: (cell % p.columns) * p.frameWidth,
    y: Math.floor(cell / p.columns) * p.frameHeight,
    width: p.frameWidth,
    height: p.frameHeight,
    sheetWidth: p.columns * p.frameWidth,
  };
}

// seekFrameStyle draws the frame at second t as a CSS background, width px
// wide (the frame's own width by default; the height keeps its ratio).
export function seekFrameStyle(
  p: SeekPreview,
  t: number,
  width = p.frameWidth,
): {
  width: string;
  height: string;
  backgroundImage: string;
  backgroundPosition: string;
  backgroundSize: string;
  backgroundRepeat: string;
} {
  const f = seekFrame(p, t);
  const k = width / f.width;
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  return {
    width: px(width),
    height: px(f.height * k),
    backgroundImage: `url("${f.url.replaceAll('"', '%22')}")`,
    backgroundPosition: `${px(-f.x * k)} ${px(-f.y * k)}`,
    backgroundSize: `${px(f.sheetWidth * k)} auto`,
    backgroundRepeat: 'no-repeat',
  };
}
