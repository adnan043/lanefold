// Interactive video: what the video editor stores per video (media_chapter,
// media_interaction) and the rules the player runs them by, from the editor's
// Preview as student. Pure: the player (components/video-interactions.tsx)
// keeps the clock and the screen.

export type VideoChapter = {start: number; title: string}; // seconds

// VideoMark is a point on the seek bar (a lesson's moment): a dot at time
// seconds, its title on hover.
export type VideoMark = {time: number; title: string};

// Objects show over a time range; panels and events fire at one moment.
export type InteractionObjectType = 'button' | 'hotspot' | 'text' | 'image' | 'embed';
export type InteractionPanelType = 'question' | 'gate';
export type InteractionEventType = 'jump' | 'pause' | 'switch' | 'reset';
export type InteractionType = InteractionObjectType | InteractionPanelType | InteractionEventType;

// What a viewer did with an interaction.
export type InteractionOutcome = 'clicked' | 'correct' | 'wrong' | 'skipped' | 'submitted';
// What a show condition checks: buttons and hotspots clicked or not_clicked;
// questions correct, wrong, answered or skipped; gates submitted or skipped.
export type InteractionRuleOp = InteractionOutcome | 'not_clicked' | 'answered';

export type InteractionAction =
  | 'continue'
  | 'time'
  | 'pause'
  | 'switch'
  | 'link'
  | 'reset'
  | 'none';

export type Interaction = {
  id: string;
  type: InteractionType;
  label: string; // button text, question, gate heading
  start: number; // seconds
  end: number; // seconds; equal to start for panels and events
  alwaysOn: boolean; // objects: visible for the whole video
  pauseMode: 'none' | 'show' | 'hide'; // objects: pause when shown or hidden
  // Objects: centre and width (embeds: and height) as % of the frame.
  x: number;
  y: number;
  w: number;
  h?: number;
  look: 'solid' | 'outline' | 'minimal';
  indicator: boolean; // hotspots: show the ring
  imageUrl?: string; // images
  code: string; // embeds: HTML, shown in a sandboxed frame
  // Panels: Floating card, Banner, Full frame, Side left, Side right.
  panel: 'card' | 'banner' | 'fit' | 'left' | 'right';
  px: number;
  py: number;
  pw: number;
  theme: 'light' | 'dark' | 'brand';
  ansLayout: 'list' | 'grid' | 'pills';
  dim: boolean;
  // On click; questions: on a correct answer (continue, time or switch).
  action: InteractionAction;
  jump: number; // seconds, for action and event "time"/"jump"
  switchTo: string; // video id, for "switch"
  url: string; // for "link"
  answers: {text: string; correct: boolean}[];
  hint: string;
  hintOn: boolean;
  allowSkip: boolean;
  allowRewind: boolean;
  repeat: boolean; // questions: try again after a wrong answer
  sub: string; // gate subheading
  fields: {first: boolean; last: boolean; phone: boolean}; // gate fields besides email
  btnLabel: string;
  skip: boolean; // gate: may be skipped
  once: boolean; // show once per viewer
  device: 'all' | 'desktop' | 'mobile';
  visTo: 'all' | 'tagged' | 'nobody';
  visTags: string[];
  tfOn: boolean; // show only between tfStart and tfEnd (ISO dates, end day inclusive)
  tfStart: string | null;
  tfEnd: string | null;
  soundBell: boolean;
  pauseOnClick: boolean;
  indication: boolean; // pulse to show it can be clicked
  anim: InteractionAnimation;
  ruleOn: boolean; // show conditions on earlier interactions
  ruleMode: 'all' | 'any';
  rules: {src: string; op?: InteractionRuleOp}[];
  grade: boolean; // answers go to the gradebook
  tags: string[]; // people tags added on click, correct answer or submit
};

export type InteractionAnimation =
  | 'none'
  | 'fade'
  | 'scale-up'
  | 'scale-down'
  | 'slide-right'
  | 'slide-left'
  | 'slide-bottom'
  | 'slide-top'
  | 'rotate'
  | 'blink'
  | 'bounce'
  | 'pulse'
  | 'jello'
  | 'wobble'
  | 'vibrate';

// What the player keeps per viewer across visits (learning's interaction
// response state): outcomes, once-only items seen, and whether they passed
// the email gate.
export type InteractionState = {
  outcomes: Record<string, InteractionOutcome>;
  seen: string[];
  gateDone: boolean;
};

export type GateContact = {email: string; firstName?: string; lastName?: string; phone?: string};

// What a viewer did, with their state afterwards, for the app to save
// (outcomes, gradebook answers, tags, contacts from the email gate).
export type InteractionEvent = {
  interaction: Interaction;
  outcome: InteractionOutcome | 'reset';
  answer?: number; // questions: the index of the answer picked
  contact?: GateContact; // email gate
  state: InteractionState;
};

export type InteractionViewer = {
  signedIn: boolean; // a known contact: gates don't show
  tagIds?: string[]; // for "Tagged users"
};

export const emptyInteractionState: InteractionState = {outcomes: {}, seen: [], gateDone: false};

const objectTypes: readonly InteractionType[] = ['button', 'hotspot', 'text', 'image', 'embed'];
const eventTypes: readonly InteractionType[] = ['jump', 'pause', 'switch', 'reset'];

export const isObject = (i: Interaction) => objectTypes.includes(i.type);
export const isEvent = (i: Interaction) => eventTypes.includes(i.type);
export const isPanel = (i: Interaction) => i.type === 'question' || i.type === 'gate';

// interaction fills the fields a stored record leaves out with the editor's
// defaults.
export function interaction(
  i: Partial<Interaction> & Pick<Interaction, 'id' | 'type' | 'start'>,
): Interaction {
  return {
    label: '',
    end: i.start,
    alwaysOn: false,
    pauseMode: 'none',
    x: 50,
    y: 50,
    w: 22,
    look: 'solid',
    indicator: true,
    code: '',
    panel: 'card',
    px: 50,
    py: 50,
    pw: 50,
    theme: 'light',
    ansLayout: 'list',
    dim: true,
    action: 'continue',
    jump: 0,
    switchTo: '',
    url: '',
    answers: [],
    hint: '',
    hintOn: false,
    allowSkip: false,
    allowRewind: true,
    repeat: true,
    sub: '',
    fields: {first: false, last: false, phone: false},
    btnLabel: '',
    skip: false,
    once: false,
    device: 'all',
    visTo: 'all',
    visTags: [],
    tfOn: false,
    tfStart: null,
    tfEnd: null,
    soundBell: false,
    pauseOnClick: false,
    indication: false,
    anim: 'none',
    ruleOn: false,
    ruleMode: 'all',
    rules: [],
    grade: false,
    tags: [],
    ...i,
  };
}

// triggerTime is when an interaction stops playback or runs: panels and
// events at their moment, objects when they pause at show or hide; null for
// objects that never pause.
export function triggerTime(i: Interaction): number | null {
  if (!isObject(i)) return i.start;
  if (i.pauseMode === 'show') return i.start;
  if (i.pauseMode === 'hide') return i.end;
  return null;
}

export type InteractionContext = {
  all: readonly Interaction[];
  viewer: InteractionViewer;
  state: InteractionState;
  mobile: boolean;
  now: number; // ms since the epoch
};

const day = 86_400_000;

// eligible says whether this viewer may see the interaction now.
export function eligible(i: Interaction, ctx: InteractionContext): boolean {
  const {viewer, state} = ctx;
  if (i.device === (ctx.mobile ? 'desktop' : 'mobile')) return false;
  if (i.visTo === 'nobody') return false;
  if (i.visTo === 'tagged') {
    if (!viewer.signedIn) return false;
    const tags = viewer.tagIds ?? [];
    if (i.visTags.length > 0 && !i.visTags.some((t) => tags.includes(t))) return false;
  }
  if (i.tfOn) {
    if (i.tfStart && ctx.now < Date.parse(i.tfStart)) return false;
    if (i.tfEnd && ctx.now > Date.parse(i.tfEnd) + day) return false;
  }
  if (i.once && state.seen.includes(i.id)) return false;
  if (i.type === 'gate' && (viewer.signedIn || state.gateDone)) return false;
  return conditionsPass(i, ctx);
}

// Conditions on interactions that no longer exist are ignored, as the
// editor's summary does.
function conditionsPass(i: Interaction, ctx: InteractionContext): boolean {
  if (!i.ruleOn) return true;
  const checks = i.rules.flatMap((r) => {
    const src = ctx.all.find((x) => x.id === r.src);
    if (!src) return [];
    const outcome = ctx.state.outcomes[r.src];
    const op = r.op ?? defaultOp(src);
    if (op === 'not_clicked') return [outcome !== 'clicked'];
    if (op === 'answered') return [outcome === 'correct' || outcome === 'wrong'];
    return [outcome === op];
  });
  if (checks.length === 0) return true;
  return i.ruleMode === 'any' ? checks.some(Boolean) : checks.every(Boolean);
}

function defaultOp(src: Interaction): InteractionRuleOp {
  if (src.type === 'question') return 'correct';
  if (src.type === 'gate') return 'submitted';
  return 'clicked';
}

// nextTrigger is the first interaction that stops playback or runs in
// (from, to] (with inclusive, [from, to]) that hasn't run this session and
// the viewer may see. Events at a moment run before a panel at the same one.
// requiredOnly skips events: a seek forward runs only what the viewer must
// not skip.
export function nextTrigger(
  ctx: InteractionContext,
  done: ReadonlySet<string>,
  from: number,
  to: number,
  {inclusive = false, requiredOnly = false} = {},
): Interaction | undefined {
  const lo = inclusive ? from - 1e-6 : from + 1e-6;
  let best: Interaction | undefined;
  let bestAt = Infinity;
  for (const i of ctx.all) {
    const at = triggerTime(i);
    if (at === null || at <= lo || at > to + 1e-6) continue;
    if ((requiredOnly && isEvent(i)) || done.has(i.id) || !eligible(i, ctx)) continue;
    if (at < bestAt || (at === bestAt && best && isEvent(i) && !isEvent(best))) {
      best = i;
      bestAt = at;
    }
  }
  return best;
}

// visibleObjects are the objects on screen at time t.
export function visibleObjects(ctx: InteractionContext, t: number): Interaction[] {
  return ctx.all.filter(
    (i) => isObject(i) && (i.alwaysOn || (t >= i.start && t <= i.end)) && eligible(i, ctx),
  );
}

// recordOutcome adds what the viewer did to their state.
export function recordOutcome(
  state: InteractionState,
  i: Interaction,
  outcome: InteractionOutcome,
): InteractionState {
  return {
    outcomes: {...state.outcomes, [i.id]: outcome},
    seen: markSeen(state.seen, i),
    gateDone: state.gateDone || (i.type === 'gate' && outcome === 'submitted'),
  };
}

export function markSeen(seen: string[], i: Interaction): string[] {
  return i.once && !seen.includes(i.id) ? [...seen, i.id] : seen;
}

// resetState is the state after "Reset interactions": once-only items and
// submitted gates never show again, so their outcomes stay, or conditions
// on them could never pass.
export function resetState(state: InteractionState, all: readonly Interaction[]): InteractionState {
  const outcomes = Object.fromEntries(
    Object.entries(state.outcomes).filter(([id, outcome]) => {
      const i = all.find((x) => x.id === id);
      return state.seen.includes(id) || (i?.type === 'gate' && outcome === 'submitted');
    }),
  );
  return {...state, outcomes};
}

// chapterAt is the chapter playing at second t: the last one starting at or
// before it (chapters in any order); undefined before the first or with none.
export function chapterAt(chapters: readonly VideoChapter[], t: number): VideoChapter | undefined {
  let at: VideoChapter | undefined;
  for (const c of chapters) {
    if (c.start <= t && (!at || c.start >= at.start)) at = c;
  }
  return at;
}

// chaptersVtt is a WebVTT chapters track for the chapters, each ending where
// the next starts (the last at the video's end).
export function chaptersVtt(chapters: readonly VideoChapter[]): string {
  const sorted = chapters.filter((c) => c.start >= 0);
  sorted.sort((a, b) => a.start - b.start);
  const cues = sorted.map((c, k) => {
    const end = sorted[k + 1]?.start ?? 359_999; // 99:59:59, clamped to the duration
    return `${vttTime(c.start)} --> ${vttTime(end)}\n${c.title.replaceAll('-->', '→')}`;
  });
  return ['WEBVTT', ...cues].join('\n\n');
}

// vttTrackUrl is a WebVTT track (chaptersVtt) as a blob: URL for a <track>: a
// site's CSP allows blob: media (media-src 'self' https: blob:) but not data:,
// which fails the track and leaves the seek bar one segment. The caller
// revokes it (URL.revokeObjectURL) once the track is gone.
export function vttTrackUrl(vtt: string): string {
  return URL.createObjectURL(new Blob([vtt], {type: 'text/vtt'}));
}

function vttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}
