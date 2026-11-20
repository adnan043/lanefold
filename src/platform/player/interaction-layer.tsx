import {isMediaPauseCapable, isMediaSeekCapable, useMedia} from '@videojs/react';
import {usePlayer} from '@videojs/react/video';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {useEffectEvent} from './use-effect-event';

import {
  emptyInteractionState,
  type Interaction,
  type GateContact,
  type InteractionContext,
  type InteractionEvent,
  type InteractionState,
  type InteractionViewer,
  isEvent,
  isObject,
  markSeen,
  nextTrigger,
  recordOutcome,
  resetState,
  triggerTime,
  visibleObjects,
} from './interactions';
import {usePlayerUi, type VideoPlayerClassNames} from './player-ui';

export type InteractionLayerProps = {
  interactions: readonly Interaction[];
  viewer?: InteractionViewer;
  interactionState?: InteractionState; // saved from earlier visits
  onInteraction?: (event: InteractionEvent) => void;
  onSwitchVideo?: (videoId: string) => void;
};

// A seek forward of more than this is a seek, not playback.
const seekGap = 1.5;

// InteractionLayer runs a video's interactions as the editor's Preview as
// student does: objects over the video in their time range, questions and
// the email gate stopping playback until answered, and jump, pause, switch
// and reset events. A seek forward stops at the first question or gate it
// would skip.
export function InteractionLayer({
  interactions,
  viewer = {signedIn: false},
  interactionState,
  onInteraction,
  onSwitchVideo,
}: InteractionLayerProps) {
  const {classNames: c, labels} = usePlayerUi();
  const media = useMedia();
  const player = usePlayer();
  const mobile = useCoarsePointer();
  const [now] = useState(() => Date.now());
  const [state, setState] = useState(interactionState ?? emptyInteractionState);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [notice, setNotice] = useState('');
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<Record<string, 'right' | 'wrong' | undefined>>({});
  // This session: interactions that ran, where playback was last, and the
  // moment an event last moved it to.
  const session = useRef({
    done: new Set<string>(),
    last: 0,
    eventAt: null as number | null,
    rung: new Set<string>(),
    waiting: null as string | null,
  });
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const audio = useRef<AudioContext | null>(null);

  const ctx: InteractionContext = {all: interactions, viewer, state, mobile, now};
  const byId = (id: string | null) => interactions.find((i) => i.id === id);

  const say = (text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 3600);
  };
  const bell = () => {
    audio.current = ring(audio.current);
  };
  const wait = (id: string | null) => {
    session.current.waiting = id;
    setWaiting(id);
  };
  const update = (
    i: Interaction,
    next: InteractionState,
    outcome: InteractionEvent['outcome'],
    extra?: Pick<InteractionEvent, 'answer' | 'contact'>,
  ) => {
    setState(next);
    onInteraction?.({interaction: i, outcome, state: next, ...extra});
  };
  const resume = () => void player.play().catch(() => {});
  const goTo = (t: number) => {
    session.current.last = t;
    session.current.eventAt = t;
    void player.seek(t);
  };
  const reset = (i: Interaction, from: InteractionState) => {
    session.current.done = new Set([i.id]);
    setPicks({});
    setFeedback({});
    update(i, resetState(from, interactions), 'reset');
  };

  // fire runs an interaction whose moment playback reached.
  const fire = useEffectEvent((i: Interaction) => {
    const at = triggerTime(i) ?? i.start;
    const s = session.current;
    s.done.add(i.id);
    if (i.soundBell && !isObject(i)) bell();
    const seen = markSeen(state.seen, i);
    if (seen !== state.seen) setState({...state, seen});
    if (!isEvent(i)) {
      player.pause();
      goTo(at);
      wait(i.id);
      return;
    }
    s.eventAt = at;
    switch (i.type) {
      case 'jump':
        goTo(Math.min(i.jump, isMediaSeekCapable(media) ? media.duration || i.jump : i.jump));
        break;
      case 'pause':
        player.pause();
        break;
      case 'switch':
        if (i.switchTo) onSwitchVideo?.(i.switchTo);
        break;
      case 'reset':
        reset(i, {...state, seen});
        break;
    }
  });

  // tick follows playback from where it last was: triggers it reached run,
  // and objects starting with "Sound bell" ring.
  const tick = useEffectEvent((t: number) => {
    const s = session.current;
    const from = s.last;
    s.last = t;
    if (Math.floor(t * 10) !== Math.floor(time * 10)) setTime(t);
    if (s.waiting || t < from || t - from > seekGap) {
      s.rung.clear();
      return;
    }
    const inclusive = from <= 1e-6 || (s.eventAt !== null && Math.abs(s.eventAt - from) < 1e-3);
    const hit = nextTrigger(ctx, s.done, from, t, {inclusive});
    const until = hit ? (triggerTime(hit) ?? t) : t;
    let chime = false;
    for (const i of interactions) {
      if (!i.soundBell || !isObject(i) || i.alwaysOn || s.rung.has(i.id)) continue;
      if (
        i.start < from - 1e-6 ||
        i.start > until + 1e-6 ||
        !visibleObjects(ctx, i.start).includes(i)
      )
        continue;
      s.rung.add(i.id);
      chime = true;
    }
    if (chime) bell();
    if (hit) fire(hit);
  });

  // seeking keeps a viewer on a step they must finish, and stops a seek
  // forward at the first question or gate it passes.
  const seeking = useEffectEvent((t: number) => {
    const s = session.current;
    const w = byId(s.waiting);
    const at = w ? (triggerTime(w) ?? w.start) : 0;
    if (w && Math.abs(t - at) > 0.05) {
      if (t > at || (w.type === 'question' && !w.allowRewind)) {
        say(w.type === 'question' ? labels.answerToContinue : labels.finishStep);
        goTo(at);
        return;
      }
      wait(null);
    }
    if (!w && t > s.last + 1e-3) {
      const hit = nextTrigger(ctx, s.done, s.last, t, {requiredOnly: true});
      if (hit) {
        fire(hit);
        return;
      }
    }
    s.last = t;
    s.rung.clear();
  });

  // play keeps playback stopped while a step waits for the viewer.
  const playing = useEffectEvent(() => {
    const w = byId(session.current.waiting);
    if (!w) return;
    player.pause();
    say(w.type === 'question' ? labels.answerToContinue : labels.finishStep);
  });

  useEffect(() => {
    if (!isMediaSeekCapable(media)) return;
    const events = media as unknown as EventTarget;
    let frame = 0;
    const loop = () => {
      if (!media.seeking) tick(media.currentTime);
      if (!(isMediaPauseCapable(media) && media.paused)) frame = requestAnimationFrame(loop);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };
    const onSeeking = () => seeking(media.currentTime);
    const onTime = () => tick(media.currentTime);
    const onPlay = () => {
      playing();
      start();
    };
    events.addEventListener('play', onPlay);
    events.addEventListener('seeking', onSeeking);
    events.addEventListener('timeupdate', onTime);
    return () => {
      cancelAnimationFrame(frame);
      events.removeEventListener('play', onPlay);
      events.removeEventListener('seeking', onSeeking);
      events.removeEventListener('timeupdate', onTime);
    };
  }, [media]);

  useEffect(
    () => () => {
      clearTimeout(noticeTimer.current);
      void audio.current?.close().catch(() => {});
    },
    [],
  );

  // act runs what clicking an object does.
  const act = (i: Interaction) => {
    const s = session.current;
    const wasWaiting = s.waiting === i.id;
    const wasPlaying = isMediaPauseCapable(media) && !media.paused;
    s.done.add(i.id);
    // Moving the viewer on (another moment, a reset) ends any step waiting.
    if (wasWaiting || i.action === 'time' || i.action === 'reset') wait(null);
    const next = recordOutcome(state, i, 'clicked');
    if (i.action === 'reset') {
      reset(i, next);
      resume();
      return;
    }
    update(i, next, 'clicked');
    switch (i.action) {
      case 'time':
        goTo(i.jump);
        resume();
        return;
      case 'switch':
        if (i.switchTo && onSwitchVideo) {
          onSwitchVideo(i.switchTo);
          return;
        }
        break;
      case 'pause':
        player.pause();
        return;
      case 'link':
        if (/^https?:\/\//i.test(i.url)) window.open(i.url, '_blank', 'noopener,noreferrer');
        break;
    }
    if (i.pauseOnClick) player.pause();
    else if (wasWaiting || wasPlaying) resume();
  };

  // finish closes a question or gate and plays on (a correct answer may
  // jump or switch).
  const finish = (
    i: Interaction,
    next: InteractionState,
    event: Omit<InteractionEvent, 'interaction' | 'state'>,
  ) => {
    session.current.done.add(i.id);
    wait(null);
    update(i, next, event.outcome, event);
    if (event.outcome === 'correct' && i.action === 'time') goTo(i.jump);
    if (event.outcome === 'correct' && i.action === 'switch' && i.switchTo && onSwitchVideo) {
      onSwitchVideo(i.switchTo);
      return;
    }
    resume();
  };

  const check = (i: Interaction) => {
    const fb = feedback[i.id];
    const pick = picks[i.id];
    if (fb === 'right')
      return finish(i, recordOutcome(state, i, 'correct'), {outcome: 'correct', answer: pick});
    if (fb === 'wrong' && !i.repeat)
      return finish(i, recordOutcome(state, i, 'wrong'), {outcome: 'wrong', answer: pick});
    if (pick === undefined) return say(labels.chooseAnswer);
    setFeedback({...feedback, [i.id]: i.answers[pick]?.correct ? 'right' : 'wrong'});
  };

  const skip = (i: Interaction) =>
    finish(i, recordOutcome(state, i, 'skipped'), {outcome: 'skipped'});

  const objects = visibleObjects(ctx, time);
  const panel = byId(waiting);
  return (
    <section aria-label={labels.interactions} className={c.interactions}>
      {objects.map((i) => (
        <InteractionObject
          key={i.id}
          interaction={i}
          waiting={waiting === i.id}
          onClick={() => act(i)}
          c={c}
        />
      ))}
      {panel?.type === 'question' && (
        <PanelFrame interaction={panel} label={labels.question} c={c}>
          <QuestionPanel
            interaction={panel}
            pick={picks[panel.id]}
            feedback={feedback[panel.id]}
            onPick={(k) => {
              setPicks({...picks, [panel.id]: k});
              if (feedback[panel.id] === 'wrong') setFeedback({...feedback, [panel.id]: undefined});
            }}
            onCheck={() => check(panel)}
            onSkip={panel.allowSkip ? () => skip(panel) : undefined}
          />
        </PanelFrame>
      )}
      {panel?.type === 'gate' && (
        <PanelFrame interaction={panel} label={labels.emailGate} c={c}>
          <GatePanel
            interaction={panel}
            onSubmit={(contact) =>
              finish(panel, recordOutcome(state, panel, 'submitted'), {
                outcome: 'submitted',
                contact,
              })
            }
            onSkip={panel.skip ? () => skip(panel) : undefined}
          />
        </PanelFrame>
      )}
      {notice && <output className={c.notice}>{notice}</output>}
    </section>
  );
}

// What the editor set for the look, for CSS: the entrance animation and the
// "clickable" pulse are data attributes, the place on the frame is inline.
function objectData(i: Interaction) {
  return {
    'data-type': i.type,
    'data-look': i.look,
    'data-animation': i.anim === 'none' ? undefined : i.anim,
    'data-indicate':
      i.indication && i.type !== 'embed' && !(i.type === 'hotspot' && !i.indicator)
        ? ''
        : undefined,
  };
}

function InteractionObject({
  interaction: i,
  waiting,
  onClick,
  c,
}: {
  interaction: Interaction;
  waiting: boolean;
  onClick: () => void;
  c: VideoPlayerClassNames;
}) {
  const place: CSSProperties = {
    position: 'absolute',
    left: `${i.x}%`,
    top: `${i.y}%`,
    width: `${i.w}%`,
    translate: '-50% -50%',
  };
  const data = objectData(i);
  const passive = i.action === 'none' && !waiting;
  switch (i.type) {
    case 'button':
      return (
        <button
          type="button"
          data-interactive
          {...data}
          className={c.object}
          style={place}
          onClick={onClick}
        >
          {i.label}
        </button>
      );
    case 'text':
      return (
        <ObjectBox
          passive={passive}
          data={data}
          className={c.object}
          style={place}
          onClick={onClick}
        >
          {i.label}
        </ObjectBox>
      );
    case 'image':
      return i.imageUrl ? (
        <ObjectBox
          passive={passive}
          data={data}
          className={c.object}
          style={place}
          onClick={onClick}
        >
          <img src={i.imageUrl} alt={i.label} className={c.image} />
        </ObjectBox>
      ) : null;
    case 'hotspot':
      return (
        <button
          type="button"
          data-interactive
          {...data}
          data-indicator={i.indicator ? '' : undefined}
          aria-label={i.label}
          className={c.object}
          style={{...place, aspectRatio: '1'}}
          onClick={onClick}
        >
          {i.indicator && (
            <>
              <span className={c.hotspotRing} />
              {i.label && <span className={c.hotspotLabel}>{i.label}</span>}
            </>
          )}
        </button>
      );
    case 'embed': {
      const w = Math.min(100, i.w);
      const h = Math.min(100, i.h ?? 50);
      const box: CSSProperties = {
        position: 'absolute',
        left: `${Math.min(100 - w / 2, Math.max(w / 2, i.x))}%`,
        top: `${Math.min(100 - h / 2, Math.max(h / 2, i.y))}%`,
        width: `${w}%`,
        height: `${h}%`,
        translate: '-50% -50%',
      };
      return i.code.trim() ? (
        <div data-interactive {...data} className={c.object} style={box}>
          {/* No allow-same-origin: the school's code runs in an opaque origin. */}
          <iframe
            title={i.label}
            srcDoc={i.code}
            sandbox="allow-scripts allow-forms allow-popups"
            className={c.embedFrame}
          />
        </div>
      ) : null;
    }
    default:
      return null;
  }
}

// ObjectBox is a text or image that is a button only when clicking it does
// something.
function ObjectBox({
  passive,
  data,
  className,
  style,
  onClick,
  children,
}: {
  passive: boolean;
  data: ReturnType<typeof objectData>;
  className?: string;
  style: CSSProperties;
  onClick: () => void;
  children: ReactNode;
}) {
  if (passive)
    return (
      <div
        {...data}
        data-passive=""
        className={className}
        style={{...style, pointerEvents: 'none'}}
      >
        {children}
      </div>
    );
  return (
    <button
      type="button"
      data-interactive
      {...data}
      className={className}
      style={style}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// PanelFrame places a question or the email gate: a floating card and a
// banner where the editor put them, the other layouts by data-layout.
function PanelFrame({
  interaction: i,
  label,
  c,
  children,
}: {
  interaction: Interaction;
  label: string;
  c: VideoPlayerClassNames;
  children: ReactNode;
}) {
  const place: CSSProperties =
    i.panel === 'card'
      ? {left: `${i.px}%`, top: `${i.py}%`, width: `${i.pw}%`}
      : i.panel === 'banner'
        ? {top: `${i.py}%`}
        : {};
  return (
    <div
      data-interactive
      data-dim={i.panel !== 'fit' && i.dim ? '' : undefined}
      className={c.panelBackdrop}
    >
      <dialog
        open
        aria-label={label}
        data-layout={i.panel}
        data-variant={i.type === 'question' ? i.theme : 'light'}
        {...objectData(i)}
        className={c.panel}
        style={place}
      >
        {children}
      </dialog>
    </div>
  );
}

function QuestionPanel({
  interaction: i,
  pick,
  feedback,
  onPick,
  onCheck,
  onSkip,
}: {
  interaction: Interaction;
  pick: number | undefined;
  feedback: 'right' | 'wrong' | undefined;
  onPick: (k: number) => void;
  onCheck: () => void;
  onSkip?: () => void;
}) {
  const {classNames: c, labels} = usePlayerUi();
  const correct = i.answers.find((a) => a.correct)?.text ?? '';
  const done = feedback === 'right' || (feedback === 'wrong' && !i.repeat);
  return (
    <>
      <p className={c.panelTitle}>{i.label}</p>
      <fieldset
        disabled={done}
        data-layout={i.panel === 'banner' ? 'pills' : i.ansLayout}
        className={c.answers}
      >
        <legend style={visuallyHidden}>{labels.answers}</legend>
        {i.answers.map((a, k) => (
          <label key={k} data-checked={pick === k ? '' : undefined} className={c.answer}>
            <input
              type="radio"
              name={`answer-${i.id}`}
              checked={pick === k}
              onChange={() => onPick(k)}
              className={c.answerInput}
            />
            <span aria-hidden className={c.answerDot} />
            <span>{a.text}</span>
          </label>
        ))}
      </fieldset>
      {feedback && (
        <output data-result={feedback} className={c.feedback}>
          {feedback === 'right'
            ? labels.correct
            : i.repeat
              ? labels.tryAgain
              : labels.wrongAnswer(correct)}
        </output>
      )}
      {feedback === 'wrong' && i.hintOn && i.hint && (
        <p className={c.panelText}>{labels.hint(i.hint)}</p>
      )}
      <div className={c.panelActions}>
        {onSkip && (
          <button type="button" className={c.panelSkip} onClick={onSkip}>
            {labels.skip}
          </button>
        )}
        <button type="button" className={c.panelSubmit} onClick={onCheck}>
          {done ? labels.continue : labels.checkAnswer}
        </button>
      </div>
    </>
  );
}

const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function GatePanel({
  interaction: i,
  onSubmit,
  onSkip,
}: {
  interaction: Interaction;
  onSubmit: (contact: GateContact) => void;
  onSkip?: () => void;
}) {
  const {classNames: c, labels} = usePlayerUi();
  const id = useId();
  const [contact, setContact] = useState<GateContact>({email: ''});
  const [invalid, setInvalid] = useState(false);
  const fields: {key: keyof GateContact; label: string; type: string; autoComplete: string}[] = [
    {key: 'email', label: labels.email, type: 'email', autoComplete: 'email'},
  ];
  if (i.fields.first)
    fields.push({
      key: 'firstName',
      label: labels.firstName,
      type: 'text',
      autoComplete: 'given-name',
    });
  if (i.fields.last)
    fields.push({
      key: 'lastName',
      label: labels.lastName,
      type: 'text',
      autoComplete: 'family-name',
    });
  if (i.fields.phone)
    fields.push({key: 'phone', label: labels.phone, type: 'tel', autoComplete: 'tel'});
  return (
    <form
      noValidate
      style={{display: 'contents'}}
      onSubmit={(e) => {
        e.preventDefault();
        const email = contact.email.trim();
        if (!emailPattern.test(email)) return setInvalid(true);
        onSubmit({...contact, email});
      }}
    >
      <p className={c.panelTitle}>{i.label}</p>
      {i.sub && <p className={c.panelText}>{i.sub}</p>}
      {fields.map((f) => {
        const bad = f.key === 'email' && invalid;
        return (
          <div key={f.key} data-invalid={bad ? '' : undefined} className={c.field}>
            <label htmlFor={`${id}-${f.key}`} className={c.fieldLabel}>
              {f.label}
            </label>
            <input
              id={`${id}-${f.key}`}
              type={f.type}
              autoComplete={f.autoComplete}
              aria-invalid={bad}
              aria-describedby={bad ? `${id}-error` : undefined}
              value={contact[f.key] ?? ''}
              onChange={(e) => {
                setContact({...contact, [f.key]: e.target.value});
                if (f.key === 'email') setInvalid(false);
              }}
              className={c.fieldInput}
            />
            {bad && (
              <p id={`${id}-error`} className={c.fieldError}>
                {labels.invalidEmail}
              </p>
            )}
          </div>
        );
      })}
      <div className={c.panelActions}>
        {onSkip && (
          <button type="button" className={c.panelSkip} onClick={onSkip}>
            {labels.skip}
          </button>
        )}
        <button type="submit" className={c.panelSubmit}>
          {i.btnLabel || labels.continue}
        </button>
      </div>
    </form>
  );
}

// ring plays a short chime, reusing one audio context.
function ring(context: AudioContext | null): AudioContext | null {
  try {
    const ac = context && context.state !== 'closed' ? context : new AudioContext();
    void ac.resume().catch(() => {});
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const t = ac.currentTime;
    osc.frequency.setValueAtTime(1046, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 1);
    return ac;
  } catch {
    return context; // no audio: stay silent
  }
}

const coarse = '(pointer: coarse)';

function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(coarse);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(coarse).matches,
    () => false,
  );
}
