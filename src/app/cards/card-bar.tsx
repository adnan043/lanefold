import {type ReactNode, type RefObject, useEffect, useMemo, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {nextAfter} from '../../lib/recurrence';
import {Avatar, Badge, Button, Checkbox, Icon, type IconName, IconButton, SearchInput, Select} from '../../portal/ui';
import {Chip} from '../../portal/ui/chips';
import {addDays, parseISODate, todayISO} from '../../portal/ui/date';
import {Calendar, Popover} from '../../portal/ui/popover';
import {useRecurrence, useRecurrenceActions} from '../recurrence/api';
import {useAction} from './parts';
import {LabelDialog, symbolOf, useColorblind} from './pickers';
import {type CardActions, type DetailT, type LabelT, usePeople} from './use-card';

/**
 * Trello's card-back controls under the title: the "+ Add" button and its "Add to card" menu, the Labels, Dates,
 * Checklist and Members buttons, each opening its own small popover, and the Members / Labels / Dates summary that
 * appears once the card has any of them. One popover is open at a time; it hangs from the button that opened it.
 * The buttons keep the ids the board's quick actions press (`src/app/boards/quick-action.ts`).
 */

type Kind = 'add' | 'labels' | 'dates' | 'checklist' | 'members';
type Anchor = RefObject<HTMLElement | null>;
type OpenPop = {kind: Kind; anchor: Anchor} | null;

const LABELS_SHOWN = 12;
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/** The popover's title bar: the name centred, a close button at the end (Trello). */
export function PopHead({title, onClose}: {title: string; onClose: () => void}) {
  const t = useT();
  return (
    <div className="cd-pop-head">
      <span className="cd-pop-head-pad" aria-hidden="true" />
      <strong>{title}</strong>
      <IconButton icon="x" size="sm" label={t('common.close')} onClick={onClose} />
    </div>
  );
}

/* ------------------------------------------------------------------ add menu */

function AddMenu({anchor, onClose, onPick}: {anchor: Anchor; onClose: () => void; onPick: (kind: Kind | 'attachment' | 'fields') => void}) {
  const t = useT();
  const items: {kind: Kind | 'attachment' | 'fields'; icon: IconName; label: string; hint: string}[] = [
    {kind: 'labels', icon: 'tag', label: t('cd.labels'), hint: t('cd.addHintLabels')},
    {kind: 'dates', icon: 'clock', label: t('cd.dates'), hint: t('cd.addHintDates')},
    {kind: 'checklist', icon: 'check-square', label: t('cd.checklistDefault'), hint: t('cd.addHintChecklist')},
    {kind: 'members', icon: 'user', label: t('cd.members'), hint: t('cd.addHintMembers')},
    {kind: 'attachment', icon: 'paperclip', label: t('cd.attachment'), hint: t('cd.addHintAttachment')},
    {kind: 'fields', icon: 'select-box', label: t('cd.fields'), hint: t('cd.addHintFields')},
  ];
  return (
    <Popover open onClose={onClose} anchor={anchor} label={t('cd.addToCard')} className="cd-pop cd-add-pop">
      <PopHead title={t('cd.addToCard')} onClose={onClose} />
      <ul className="cd-add-list">
        {items.map((item, i) => (
          <li key={item.kind}>
            <button type="button" className="cd-add-item" data-autofocus={i === 0 ? '' : undefined} onClick={() => onPick(item.kind)}>
              <span className="cd-add-icon">
                <Icon name={item.icon} size={16} />
              </span>
              <span>
                <span className="cd-add-title">{item.label}</span>
                <span className="cd-add-hint">{item.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

/* ------------------------------------------------------------------ labels */

function LabelsPop({detail, actions, anchor, onClose, onEdit}: {detail: DetailT; actions: CardActions; anchor: Anchor; onClose: () => void; onEdit: (label: LabelT | 'new') => void}) {
  const t = useT();
  const {busy, run} = useAction();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [colorblind, setColorblind] = useColorblind();
  const needle = q.trim().toLowerCase();
  const matching = needle ? detail.labels.filter(l => l.name.toLowerCase().includes(needle)) : detail.labels;
  const shown = needle || all ? matching : matching.slice(0, LABELS_SHOWN);
  return (
    <Popover open onClose={onClose} anchor={anchor} label={t('cd.labels')} className="cd-pop cd-labels-pop">
      <PopHead title={t('cd.labels')} onClose={onClose} />
      <SearchInput label={t('cd.labelsSearch')} placeholder={t('cd.labelsSearch')} value={q} onChange={event => setQ(event.target.value)} autoComplete="off" data-autofocus />
      <p className="cd-pop-sub">{t('cd.labels')}</p>
      <ul className="cd-pick-list cd-label-list" data-cb={colorblind ? '' : undefined}>
        {shown.map(l => {
          const on = detail.labelIds.includes(l.id);
          return (
            <li key={l.id}>
              <Checkbox
                label={
                  <Chip color={l.colorHex} size="sm">
                    {colorblind && <span aria-hidden="true">{symbolOf(l.colorHex)} </span>}
                    {l.name || <span className="sr-only">{l.colorHex}</span>}
                  </Chip>
                }
                checked={on}
                disabled={busy !== null}
                onChange={() => void run(`label-${l.id}`, () => actions.setLabel(l.id, !on))}
              />
              <IconButton icon="pencil" size="sm" label={t('cd.labelEdit')} onClick={() => onEdit(l)} />
            </li>
          );
        })}
      </ul>
      {needle && shown.length === 0 && <p className="cd-none">{t('cd.labelsNoMatch')}</p>}
      <Button size="sm" variant="secondary" className="cd-pop-wide" onClick={() => onEdit('new')}>
        {t('cd.labelCreate')}
      </Button>
      {!needle && matching.length > LABELS_SHOWN && (
        <Button size="sm" variant="secondary" className="cd-pop-wide" aria-expanded={all} onClick={() => setAll(v => !v)}>
          {all ? t('cd.labelsShowFewer') : t('cd.labelsShowMore')}
        </Button>
      )}
      <hr className="cd-pop-rule" />
      <Button size="sm" variant="secondary" className="cd-pop-wide" aria-pressed={colorblind} onClick={() => setColorblind(!colorblind)}>
        {colorblind ? t('cd.labelsColorblindOff') : t('cd.labelsColorblind')}
      </Button>
    </Popover>
  );
}

/* ------------------------------------------------------------------ members */

function MembersPop({detail, actions, anchor, onClose}: {detail: DetailT; actions: CardActions; anchor: Anchor; onClose: () => void}) {
  const t = useT();
  const {busy, run} = useAction();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(q.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [q]);
  const people = usePeople(detail.card.id, debounced, true);
  const needle = q.trim().toLowerCase();
  const onCard = detail.members.filter(m => !needle || (m.name || '').toLowerCase().includes(needle));
  const others = (people.data?.items ?? []).filter(p => !detail.members.some(m => m.id === p.id));
  const capped = (people.data?.items.length ?? 0) >= 20;
  const row = (person: {id: number; name: string}, on: boolean) => (
    <li key={person.id}>
      <button
        type="button"
        className="cd-pick"
        aria-pressed={on}
        disabled={busy !== null}
        onClick={() => void run(`m-${person.id}`, () => actions.setMember({id: person.id, name: person.name}, !on))}>
        <Avatar name={person.name || '?'} size="sm" />
        <span className="cd-pick-name">{person.name || t('cd.deletedUser')}</span>
        {on && <Icon name="x" size={16} />}
      </button>
    </li>
  );
  return (
    <Popover open onClose={onClose} anchor={anchor} label={t('cd.members')} className="cd-pop cd-members-pop">
      <PopHead title={t('cd.members')} onClose={onClose} />
      <SearchInput label={t('cd.membersSearch')} placeholder={t('cd.membersSearch')} value={q} onChange={event => setQ(event.target.value)} autoComplete="off" data-autofocus />
      {onCard.length > 0 && (
        <>
          <p className="cd-pop-sub">{t('cd.cardMembers')}</p>
          <ul className="cd-pick-list">{onCard.map(m => row(m, true))}</ul>
        </>
      )}
      <p className="cd-pop-sub">{t('cd.boardMembers')}</p>
      <ul className="cd-pick-list" aria-busy={people.isFetching || undefined}>
        {others.map(p => row(p, false))}
      </ul>
      {people.isError && (
        <p className="field-error" role="alert">
          {t('states.loadError')}
        </p>
      )}
      {people.data && others.length === 0 && <p className="cd-none">{t('cd.peopleEmpty')}</p>}
      {capped && <p className="cd-pop-note">{t('cd.peopleMore')}</p>}
    </Popover>
  );
}

/* ------------------------------------------------------------------ checklist */

function ChecklistPop({detail, actions, anchor, onClose}: {detail: DetailT; actions: CardActions; anchor: Anchor; onClose: () => void}) {
  const t = useT();
  const {busy, run, blocked} = useAction();
  const [title, setTitle] = useState(t('cd.checklistDefault'));
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  const sources = detail.checklists.filter(l => l.items.length > 0);
  const submit = async () => {
    const name = title.trim();
    if (!name) return setError(t('cd.textRequired'));
    if (name.length > 100) return setError(t('cd.textTooLong', {max: 100}));
    setError('');
    const from = detail.checklists.find(l => String(l.id) === source);
    let madeId = 0;
    const ok = await run('add', async () => {
      const made = await actions.addChecklist(name);
      madeId = made.id;
      // Copy in the server's batches of 20 (a checklist holds 100 at most).
      const texts = from ? from.items.map(i => i.text) : [];
      for (let i = 0; i < texts.length; i += 20) await actions.addItems(made.id, texts.slice(i, i + 20));
    });
    if (!ok) return;
    onClose();
    // Like Trello: the new checklist opens its "Add an item" box.
    window.setTimeout(() => document.querySelector<HTMLElement>(`.cd-panel [data-checklist="${madeId}"] .cd-add-item-open`)?.click(), 0);
  };
  return (
    <Popover open onClose={onClose} anchor={anchor} label={t('cd.checklistAddTitle')} className="cd-pop cd-checklist-pop">
      <PopHead title={t('cd.checklistAddTitle')} onClose={onClose} />
      <form
        className="cd-pop-form"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}>
        <label className="cd-pop-label" htmlFor="cd-new-checklist">
          {t('cd.checklistTitleLabel')}
        </label>
        <input
          ref={input}
          id="cd-new-checklist"
          value={title}
          maxLength={200}
          autoComplete="off"
          data-autofocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'cd-new-checklist-error' : undefined}
          onChange={event => {
            setTitle(event.target.value);
            if (error) setError('');
          }}
        />
        {error && (
          <p id="cd-new-checklist-error" className="field-error" role="alert">
            {error}
          </p>
        )}
        <label className="cd-pop-label" htmlFor="cd-copy-from">
          {t('cd.checklistCopyFrom')}
        </label>
        <Select
          id="cd-copy-from"
          value={source}
          onChange={event => setSource(event.target.value)}
          options={[{value: '', label: t('cd.checklistCopyNone')}, ...sources.map(l => ({value: String(l.id), label: l.title}))]}
        />
        <Button type="submit" className="cd-pop-wide" pending={busy === 'add'} pendingLabel={t('common.saving')} disabled={blocked}>
          {t('cd.add')}
        </Button>
      </form>
    </Popover>
  );
}

/* ------------------------------------------------------------------ dates */

/**
 * Typing a date in the person's own numeric order (M/D/YYYY, D.M.YYYY, YYYY/M/D…), Latin digits and the Gregorian
 * calendar whatever the locale's defaults, so what is typed and what is shown always match.
 */
export function useNumericDate(locale: string) {
  return useMemo(() => {
    let f: Intl.DateTimeFormat;
    try {
      f = new Intl.DateTimeFormat(`${locale}-u-ca-gregory-nu-latn`, {year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC'});
    } catch {
      f = new Intl.DateTimeFormat('en-US', {year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC'});
    }
    const parts = f.formatToParts(new Date(Date.UTC(2001, 1, 3)));
    const order = parts.map(p => p.type).filter((type): type is 'year' | 'month' | 'day' => type === 'year' || type === 'month' || type === 'day');
    const pattern = parts.map(p => (p.type === 'year' ? 'YYYY' : p.type === 'month' ? 'M' : p.type === 'day' ? 'D' : p.value)).join('');
    const format = (iso: string) => (parseISODate(iso) ? f.format(new Date(`${iso}T00:00:00Z`)) : '');
    const parse = (text: string): string | null => {
      const nums = text.match(/\d+/g);
      if (!nums || nums.length !== 3) return null;
      const v = {year: 0, month: 0, day: 0};
      order.forEach((key, i) => (v[key] = Number(nums[i])));
      if (v.year < 100) v.year += 2000;
      const iso = `${String(v.year).padStart(4, '0')}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`;
      return parseISODate(iso) ? iso : null;
    };
    return {pattern, format, parse};
  }, [locale]);
}

type Repeat = 'never' | 'daily' | 'weekly' | 'monthly';

/** The reminder choices, minutes before the due time (the server's REMIND_MINUTES). */
export const REMINDERS = [0, 5, 10, 15, 60, 120, 1440, 2880] as const;
/** A due time picked for the first time reminds the day before, like a card with a due day only. */
export const DEFAULT_REMIND = 1440;
export const NOON = 12 * 60;
/** Minutes after local midnight of an ISO instant. */
export const minutesOf = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};
/** The instant of a local day (`YYYY-MM-DD`) at a local time (minutes after midnight), as ISO. */
export const instantAt = (day: string, minutes: number) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60).toISOString();
};

/** The due time choices: every half hour, plus a saved time between them, labelled in the person's locale. */
export function dueTimeOptions(locale: string, time: number) {
  const format = new Intl.DateTimeFormat(locale, {hour: 'numeric', minute: '2-digit'});
  const steps = Array.from({length: 48}, (_, i) => i * 30);
  if (!steps.includes(time)) steps.push(time), steps.sort((a, b) => a - b);
  return steps.map(m => ({value: String(m), label: format.format(new Date(2000, 0, 1, Math.floor(m / 60), m % 60))}));
}
/** The reminder choices, "None" first. */
export function remindOptions(t: ReturnType<typeof useT>) {
  return [{value: 'none', label: t('cd.remindNone')}, ...REMINDERS.map(m => ({value: String(m), label: t(`cd.remind${m}` as 'cd.remind0')}))];
}

export function DateField({id, label, on, onToggle, text, onText, onFocus, active, error, placeholder, children}: {
  id: string;
  label: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  text: string;
  onText: (text: string) => void;
  onFocus: () => void;
  active: boolean;
  error: string;
  placeholder: string;
  /** More controls on the same row (the due time). */
  children?: ReactNode;
}) {
  return (
    <div className="cd-date-field" data-active={active && on ? '' : undefined}>
      <label className="cd-pop-label" htmlFor={id}>
        {label}
      </label>
      <div className="cd-date-row">
        <input type="checkbox" className="cd-date-check" checked={on} aria-label={label} onChange={event => onToggle(event.target.checked)} />
        <input
          id={id}
          className="cd-date-text"
          data-autofocus={active && on ? '' : undefined}
          value={text}
          disabled={!on}
          placeholder={placeholder}
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onFocus={onFocus}
          onChange={event => onText(event.target.value)}
        />
        {children}
      </div>
      {error && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function DatesPop({detail, actions, anchor, onClose}: {detail: DetailT; actions: CardActions; anchor: Anchor; onClose: () => void}) {
  const t = useT();
  const {locale, firstDayOfWeek, errorMessage} = useI18n();
  const {card, canWrite} = detail;
  const numeric = useNumericDate(locale);
  const today = todayISO();
  const startSaved = day(card.startDate);
  // With a time, the day is the instant's day on THIS person's clock: the stored due day is the setter's local day, and
  // mixing it with a local time would rebuild a different instant (a day off across time zones).
  const dueSaved = card.dueAt ? todayISO(new Date(card.dueAt)) : day(card.dueDate);
  // Nothing set yet: Trello offers a due date of tomorrow.
  const [startOn, setStartOn] = useState(!!startSaved);
  const [dueOn, setDueOn] = useState(!!dueSaved || !startSaved);
  const [start, setStart] = useState(startSaved || today);
  const [due, setDue] = useState(dueSaved || addDays(today, 1));
  const [startText, setStartText] = useState(numeric.format(start));
  const [dueText, setDueText] = useState(numeric.format(due));
  const [active, setActive] = useState<'start' | 'due'>(dueOn ? 'due' : 'start');
  const savedAt = card.dueAt;
  const savedRemind = savedAt ? card.dueRemindMinutes : DEFAULT_REMIND;
  const [time, setTime] = useState(savedAt ? minutesOf(savedAt) : NOON);
  const [remind, setRemind] = useState<number | null>(savedRemind);
  /** The person picked a time or a reminder (a card with a due day only gets a time only then, or with a new day). */
  const [timeTouched, setTimeTouched] = useState(false);
  const [errors, setErrors] = useState<{start?: string; due?: string}>({});
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<'save' | 'remove' | null>(null);
  const recurrence = useRecurrence(card.id);
  const {save: saveRule, stop: stopRule} = useRecurrenceActions(card.id);
  const rule = recurrence.data?.recurrence?.enabled ? recurrence.data.recurrence : null;
  const savedRepeat: Repeat = rule?.frequency ?? 'never';
  const [repeat, setRepeat] = useState<Repeat | null>(null);
  const chosenRepeat = repeat ?? savedRepeat;

  const setFrom = (which: 'start' | 'due', iso: string) => {
    if (which === 'start') {
      setStart(iso);
      setStartText(numeric.format(iso));
    } else {
      setDue(iso);
      setDueText(numeric.format(iso));
    }
    setErrors(e => ({...e, [which]: undefined}));
  };
  const typed = (which: 'start' | 'due', text: string) => {
    (which === 'start' ? setStartText : setDueText)(text);
    const iso = numeric.parse(text);
    if (iso) (which === 'start' ? setStart : setDue)(iso);
    setErrors(e => ({...e, [which]: undefined}));
  };
  const pick = (iso: string) => {
    if (active === 'start' && startOn) return setFrom('start', iso);
    setDueOn(true);
    setActive('due');
    setFrom('due', iso);
  };

  const base = (dueOn ? due : startOn ? start : '') || today;
  const timeOptions = dueTimeOptions(locale, time);
  const reminderOptions = remindOptions(t);
  const repeatOptions = [
    {value: 'never', label: t('cd.repeatNever')},
    {value: 'daily', label: t('rec.freq.daily')},
    {value: 'weekly', label: t('cd.repeatWeeklyOn', {day: new Intl.DateTimeFormat(locale, {weekday: 'long', timeZone: 'UTC'}).format(new Date(`${base}T00:00:00Z`))})},
    {value: 'monthly', label: t('cd.repeatMonthlyOn', {n: Number(base.slice(8, 10))})},
  ];

  const save = async () => {
    const next: {start?: string; due?: string} = {};
    if (startOn && !numeric.parse(startText)) next.start = t('cd.dateInvalid', {example: numeric.pattern});
    if (dueOn && !numeric.parse(dueText)) next.due = t('cd.dateInvalid', {example: numeric.pattern});
    if (!next.start && !next.due && startOn && dueOn && start > due) next.start = t('cd.dateOrder');
    setErrors(next);
    if (next.start || next.due) return;
    setStatus('');
    setPending('save');
    try {
      const patch: {startDate?: string | null; dueDate?: string | null; dueAt?: string | null; dueRemindMinutes?: number | null} = {};
      const nextStart = startOn ? start : null;
      const nextDue = dueOn ? due : null;
      if (nextStart !== (startSaved || null)) patch.startDate = nextStart;
      if (nextDue !== (dueSaved || null)) patch.dueDate = nextDue;
      // The due time and its reminder: sent only with a new due day or a picked time or reminder (never re-sent unchanged).
      const nextAt = nextDue ? instantAt(nextDue, time) : null;
      const nextRemind = nextAt ? remind : null;
      if ('dueDate' in patch || timeTouched) {
        if (nextAt !== savedAt || 'dueDate' in patch) patch.dueAt = nextAt;
        if (nextRemind !== (savedAt ? card.dueRemindMinutes : null) || 'dueAt' in patch) patch.dueRemindMinutes = nextRemind;
      }
      if (Object.keys(patch).length) await actions.patchDetails(patch);
      if (chosenRepeat !== savedRepeat) {
        if (chosenRepeat === 'never') await stopRule();
        else {
          // The first copy: the next day of the rule after today, counted from the due (or start) date.
          const startOnDay = nextAfter({frequency: chosenRepeat, interval: 1, anchor: base, endsOn: null}, today) ?? addDays(today, 1);
          await saveRule({frequency: chosenRepeat, interval: 1, startOn: startOnDay, endsOn: null});
        }
      }
      onClose();
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setPending(null);
    }
  };
  const remove = async () => {
    setStatus('');
    setPending('remove');
    try {
      if (startSaved || dueSaved) await actions.patchDetails({startDate: null, dueDate: null, dueAt: null, dueRemindMinutes: null});
      if (rule) await stopRule();
      onClose();
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setPending(null);
    }
  };
  const calendarValue = active === 'start' && startOn ? start : dueOn ? due : startOn ? start : '';
  return (
    <Popover open onClose={onClose} anchor={anchor} label={t('cd.dates')} className="cd-pop cd-dates-pop">
      <PopHead title={t('cd.dates')} onClose={onClose} />
      <form
        className="cd-pop-form"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}>
        <Calendar
          value={calendarValue}
          onPick={pick}
          locale={locale}
          firstDayOfWeek={firstDayOfWeek as 0}
          range={startOn && dueOn ? {from: start, to: due} : null}
          yearNav
          autoFocusDay={false}
        />
        <DateField
          id="cd-date-start"
          label={t('cd.startDate')}
          on={startOn}
          onToggle={on => {
            setStartOn(on);
            if (on) setActive('start');
            else setErrors(e => ({...e, start: undefined}));
          }}
          text={startOn ? startText : ''}
          onText={text => typed('start', text)}
          onFocus={() => setActive('start')}
          active={active === 'start'}
          error={errors.start ?? ''}
          placeholder={numeric.pattern}
        />
        <DateField
          id="cd-date-due"
          label={t('card.due')}
          on={dueOn}
          onToggle={on => {
            setDueOn(on);
            if (on) setActive('due');
            else setErrors(e => ({...e, due: undefined}));
          }}
          text={dueOn ? dueText : ''}
          onText={text => typed('due', text)}
          onFocus={() => setActive('due')}
          active={active === 'due'}
          error={errors.due ?? ''}
          placeholder={numeric.pattern}>
          <Select
            className="cd-date-time"
            aria-label={t('cd.dueTime')}
            value={String(time)}
            disabled={!dueOn}
            onChange={event => {
              setTime(Number(event.target.value));
              setTimeTouched(true);
            }}
            options={timeOptions}
          />
        </DateField>
        <label className="cd-pop-label" htmlFor="cd-date-remind">
          {t('cd.remindLabel')}
        </label>
        <Select
          id="cd-date-remind"
          value={remind === null ? 'none' : String(remind)}
          disabled={!dueOn}
          onChange={event => {
            setRemind(event.target.value === 'none' ? null : Number(event.target.value));
            setTimeTouched(true);
          }}
          options={reminderOptions}
        />
        {recurrence.data && (
          <>
            <label className="cd-pop-label" htmlFor="cd-date-repeat">
              {t('cd.repeat')}
            </label>
            <Select id="cd-date-repeat" value={chosenRepeat} disabled={!canWrite} onChange={event => setRepeat(event.target.value as Repeat)} options={repeatOptions} />
            {rule && rule.interval !== 1 && chosenRepeat === savedRepeat && <p className="cd-pop-note">{t('cd.repeatCustom')}</p>}
          </>
        )}
        <p className="cd-pop-note">{t('cd.remindNote')}</p>
        {status && (
          <p className="field-error" role="alert">
            {status}
          </p>
        )}
        <Button type="submit" className="cd-pop-wide" pending={pending === 'save'} pendingLabel={t('common.saving')} disabled={pending !== null}>
          {t('common.save')}
        </Button>
        <Button variant="secondary" className="cd-pop-wide" pending={pending === 'remove'} pendingLabel={t('cd.removing')} disabled={pending !== null} onClick={() => void remove()}>
          {t('cd.remove')}
        </Button>
      </form>
    </Popover>
  );
}

/* ------------------------------------------------------------------ the bar and the summary */

/** Members, labels and dates once the card has them, each with its own way back into the popover. */
function Summary({detail, open}: {detail: DetailT; open: (kind: Kind, anchor: Anchor) => void}) {
  const t = useT();
  const {formatDate} = useI18n();
  const {card, canWrite, members} = detail;
  const membersAdd = useRef<HTMLButtonElement>(null);
  const labelsAdd = useRef<HTMLButtonElement>(null);
  const datesButton = useRef<HTMLButtonElement>(null);
  const [colorblind] = useColorblind();
  const chosen = detail.labels.filter(l => detail.labelIds.includes(l.id));
  const start = day(card.startDate);
  const due = day(card.dueDate);
  const today = todayISO();
  const fmt = (iso: string) => formatDate(`${iso}T00:00:00Z`, {dateStyle: 'medium', timeZone: 'UTC'});
  const overdue = !card.completed && !!due && due < today;
  const soon = !card.completed && !!due && !overdue && due <= addDays(today, 1);
  if (members.length === 0 && chosen.length === 0 && !start && !due) return null;
  return (
    <div className="cd-summary">
      {members.length > 0 && (
        <div className="cd-summary-group">
          <span className="cd-label-text">{t('cd.members')}</span>
          <div className="cd-summary-row">
            {members.map(m => (
              <span key={m.id} className="cd-summary-avatar" title={m.name || t('cd.deletedUser')}>
                <Avatar name={m.name || '?'} size="md" />
                <span className="sr-only">{m.name || t('cd.deletedUser')}</span>
              </span>
            ))}
            {canWrite && <IconButton ref={membersAdd} icon="plus" label={t('cd.membersAssign')} className="cd-round-add" aria-haspopup="dialog" onClick={() => open('members', membersAdd)} />}
          </div>
        </div>
      )}
      {chosen.length > 0 && (
        <div className="cd-summary-group">
          <span className="cd-label-text">{t('cd.labels')}</span>
          <div className="cd-summary-row">
            {chosen.map(l => (
              <Chip key={l.id} color={l.colorHex} className="cd-summary-label">
                {colorblind && <span aria-hidden="true">{symbolOf(l.colorHex)} </span>}
                {l.name || <span className="sr-only">{l.colorHex}</span>}
              </Chip>
            ))}
            {canWrite && <IconButton ref={labelsAdd} icon="plus" label={t('cd.labelsEdit')} className="cd-round-add cd-square-add" aria-haspopup="dialog" onClick={() => open('labels', labelsAdd)} />}
          </div>
        </div>
      )}
      {(start || due) && (
        <div className="cd-summary-group">
          <span className="cd-label-text">{start && due ? t('cd.dates') : due ? t('card.due') : t('cd.startDate')}</span>
          <div className="cd-summary-row">
            <button ref={datesButton} type="button" className="cd-date-chip" disabled={!canWrite} aria-haspopup="dialog" onClick={() => open('dates', datesButton)}>
              <span dir="auto">{start && due ? `${fmt(start)} – ${fmt(due)}` : fmt(due || start)}</span>
              {card.completed ? null : overdue ? (
                <Badge tone="danger" icon="clock">{t('card.overdue')}</Badge>
              ) : soon ? (
                <Badge tone="warning" icon="clock">{t('cd.dueSoon')}</Badge>
              ) : null}
              {canWrite && <Icon name="chevron-down" size={16} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CardBar({detail, actions}: {detail: DetailT; actions: CardActions}) {
  const t = useT();
  const [pop, setPop] = useState<OpenPop>(null);
  const [editing, setEditing] = useState<LabelT | 'new' | null>(null);
  const add = useRef<HTMLButtonElement>(null);
  const labels = useRef<HTMLButtonElement>(null);
  const dates = useRef<HTMLButtonElement>(null);
  const checklist = useRef<HTMLButtonElement>(null);
  const members = useRef<HTMLButtonElement>(null);
  const open = (kind: Kind, anchor: Anchor) => setPop(p => (p?.kind === kind && p.anchor === anchor ? null : {kind, anchor}));
  const close = () => setPop(null);
  const button = (kind: Kind, ref: RefObject<HTMLButtonElement | null>, icon: IconName, label: string, id?: string) => (
    <Button ref={ref} id={id} size="sm" variant="secondary" icon={icon} aria-haspopup="dialog" aria-expanded={pop?.kind === kind && pop.anchor === ref} onClick={() => open(kind, ref)}>
      {label}
    </Button>
  );
  const fromMenu = (kind: Kind | 'attachment' | 'fields') => {
    if (kind === 'attachment' || kind === 'fields') {
      close();
      // After the menu has closed and handed focus back: the control's own picker or dialog can take it.
      const target = kind === 'attachment' ? '#cd-attachments-add' : '#cd-fields-edit';
      window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`.cd-panel ${target}`);
        el?.scrollIntoView({block: 'nearest'});
        el?.click();
      }, 0);
      return;
    }
    // Trello swaps the menu for the chosen popover, in the same place.
    setPop({kind, anchor: add});
  };
  return (
    <>
      {detail.canWrite && (
        <div className="cd-quick" role="toolbar" aria-label={t('cd.addToCard')}>
          {button('add', add, 'plus', t('cd.addButton'))}
          {button('labels', labels, 'tag', t('cd.labels'), 'cd-labels-add')}
          {button('dates', dates, 'clock', t('cd.dates'), 'cd-dueDate')}
          {button('checklist', checklist, 'check-square', t('cd.checklistDefault'))}
          {button('members', members, 'user-plus', t('cd.members'), 'cd-members-add')}
        </div>
      )}
      <Summary detail={detail} open={open} />
      {pop?.kind === 'add' && <AddMenu anchor={pop.anchor} onClose={close} onPick={fromMenu} />}
      {pop?.kind === 'labels' && (
        <LabelsPop
          detail={detail}
          actions={actions}
          anchor={pop.anchor}
          onClose={close}
          onEdit={label => {
            close();
            setEditing(label);
          }}
        />
      )}
      {pop?.kind === 'members' && <MembersPop detail={detail} actions={actions} anchor={pop.anchor} onClose={close} />}
      {pop?.kind === 'checklist' && <ChecklistPop detail={detail} actions={actions} anchor={pop.anchor} onClose={close} />}
      {pop?.kind === 'dates' && <DatesPop detail={detail} actions={actions} anchor={pop.anchor} onClose={close} />}
      <LabelDialog target={editing} actions={actions} applyTo onClose={() => setEditing(null)} />
    </>
  );
}
