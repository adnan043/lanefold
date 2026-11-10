import {type RefObject, useEffect, useId, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Avatar, Button, Icon, Menu, ProgressBar, Select, useConfirm} from '../../portal/ui';
import {addDays, todayISO} from '../../portal/ui/date';
import {Calendar, Popover} from '../../portal/ui/popover';
import {useDraft, usePeekDraft} from '../use-draft';
import {useWriteCooldown} from '../write-cooldown';
import {DEFAULT_REMIND, DateField, NOON, PopHead, dueTimeOptions, instantAt, minutesOf, remindOptions, useNumericDate} from './card-bar';
import {PeoplePopover} from './pickers';
import {useAction} from './parts';
import type {CardActions, ChecklistT, DetailT, ItemT, PersonT} from './use-card';

/** One short text input with its own Enter-to-save, Escape-to-cancel and error line. Only a Save button: Esc cancels. */
function InlineInput({
  label,
  initial = '',
  max,
  placeholder,
  submitLabel,
  pending,
  multiline,
  onSubmit,
  onCancel,
  autoFocus,
  draft,
}: {
  label: string;
  initial?: string;
  max: number;
  placeholder?: string;
  submitLabel: string;
  pending: boolean;
  multiline?: boolean;
  onSubmit: (value: string) => Promise<boolean> | boolean;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** Keep the unsent text across a forced sign-in (the checklist's id). */
  draft?: {kind: 'item' | 'itemedit' | 'checklist' | 'newlist'; id: number};
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const clearDraft = useDraft(draft?.kind ?? 'item', draft?.id ?? 0, value, setValue, initial, !!draft);
  const {blocked} = useWriteCooldown();
  const cancel =
    onCancel &&
    (() => {
      clearDraft();
      onCancel();
    });
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  /** True while a save is in flight: the input is disabled then, and that focus loss must not close the field. */
  const saving = useRef(false);
  const submit = async () => {
    if (blocked) return;
    const text = value.trim();
    if (!text) return setError(t('cd.textRequired'));
    if (text.length > max && !multiline) return setError(t('cd.textTooLong', {max}));
    setError('');
    saving.current = true;
    try {
      if (await onSubmit(text)) {
        clearDraft();
        setValue('');
        if (!onCancel) input.current?.focus();
      } else {
        // Failed: the field stays open with the text; put the caret back so a click outside still closes it.
        requestAnimationFrame(() => input.current?.focus());
      }
    } finally {
      saving.current = false;
    }
  };
  /** Several pasted lines become several items: validated per line, sent once, the field cleared only on success. */
  const paste = async (text: string) => {
    if (pending || pasting || blocked) return;
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return setError(t('cd.textRequired'));
    if (lines.some(line => line.length > max)) return setError(t('cd.textTooLong', {max}));
    setError('');
    setPasting(true);
    try {
      if (await onSubmit(lines.join('\n'))) {
        clearDraft();
        setValue('');
        if (!onCancel) input.current?.focus();
      }
    } finally {
      setPasting(false);
    }
  };
  return (
    <form
      className="cd-inline"
      noValidate
      // An edit (it has a Cancel): only Save (or Enter) keeps the change; a click anywhere outside closes it unsaved.
      onBlur={
        cancel
          ? event => {
              const next = event.relatedTarget as Node | null;
              if (next && event.currentTarget.contains(next)) return; // focus moved to Save
              if (saving.current || pending || pasting) return;
              if (!document.hasFocus()) return; // switching windows or tabs is not a click outside
              cancel();
            }
          : undefined
      }
      // Pressing Save must not blur the input first (Safari never focuses a clicked button), or the field would close
      // before the click lands.
      onMouseDown={event => {
        if (cancel && event.target !== input.current) event.preventDefault();
      }}
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}>
      <div className="cd-inline-row">
        <input
          ref={input}
          value={value}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder={placeholder}
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={pending || pasting}
          aria-busy={pasting || undefined}
          onChange={event => {
            setValue(event.target.value);
            if (error) setError('');
          }}
          onPaste={
            multiline
              ? event => {
                  // Several pasted lines become several items at once (an input cannot hold line breaks).
                  const text = event.clipboardData.getData('text').trim();
                  if (!text.includes('\n')) return;
                  event.preventDefault();
                  void paste(text);
                }
              : undefined
          }
          onKeyDown={event => {
            if (event.key === 'Escape' && cancel) {
              event.stopPropagation();
              event.preventDefault(); // the modal's native Esc must not also fire
              cancel();
            }
          }}
        />
        <Button type="submit" size="sm" disabled={blocked} pending={pending || pasting} pendingLabel={t('common.saving')}>
          {submitLabel}
        </Button>
      </div>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

type Run = ReturnType<typeof useAction>['run'];

type ItemDue = {
  dueDate: string | null;
  dueAt: string | null;
  dueRemindMinutes: number | null;
};
const NO_DUE: ItemDue = {dueDate: null, dueAt: null, dueRemindMinutes: null};

/**
 * Trello's "Change due date" for one checklist item: a calendar, the day (typed or picked) with its time, the
 * reminder, then Save and Remove. Nothing is saved until Save; the box next to the day unticked + Save removes it.
 * `onSave` does the saving: the item's PATCH for a row, or just keeping the choice for an item not added yet.
 */
function ItemDuePop({
  idKey,
  item,
  onSave,
  anchor,
  onClose,
}: {
  idKey: string;
  item: ItemDue;
  onSave: (due: ItemDue) => Promise<void> | void;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const {locale, firstDayOfWeek, errorMessage} = useI18n();
  const {blocked} = useWriteCooldown();
  const numeric = useNumericDate(locale);
  // With a time, the day is the instant's day on this person's clock (see DatesPop): day + local time rebuild the same instant.
  const first = item.dueAt ? todayISO(new Date(item.dueAt)) : item.dueDate || addDays(todayISO(), 1);
  const [on, setOn] = useState(true);
  const [due, setDue] = useState(first);
  const [text, setText] = useState(numeric.format(first));
  const [time, setTime] = useState(item.dueAt ? minutesOf(item.dueAt) : NOON);
  const [remind, setRemind] = useState<number | null>(item.dueAt ? item.dueRemindMinutes : DEFAULT_REMIND);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<'save' | 'remove' | null>(null);

  const write = async (which: 'save' | 'remove', due: ItemDue) => {
    setStatus('');
    setPending(which);
    try {
      await onSave(due);
      onClose();
    } catch (failure) {
      setStatus(errorMessage(failure));
    } finally {
      setPending(null);
    }
  };
  const save = () => {
    if (!on) return void write('remove', NO_DUE);
    const iso = numeric.parse(text);
    if (!iso) return setError(t('cd.dateInvalid', {example: numeric.pattern}));
    void write('save', {
      dueDate: iso,
      dueAt: instantAt(iso, time),
      dueRemindMinutes: remind,
    });
  };
  return (
    <Popover open onClose={onClose} anchor={anchor} label={t('cd.itemDueTitle')} className="cd-pop cd-dates-pop">
      <PopHead title={t('cd.itemDueTitle')} onClose={onClose} />
      <form
        className="cd-pop-form"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          save();
        }}>
        <Calendar
          value={on ? due : ''}
          onPick={iso => {
            setOn(true);
            setDue(iso);
            setText(numeric.format(iso));
            setError('');
          }}
          locale={locale}
          firstDayOfWeek={firstDayOfWeek as 0}
          yearNav
          autoFocusDay={false}
        />
        <DateField
          id={`cd-item-due-${idKey}`}
          label={t('card.due')}
          on={on}
          onToggle={next => {
            setOn(next);
            setError('');
          }}
          text={on ? text : ''}
          onText={value => {
            setText(value);
            const iso = numeric.parse(value);
            if (iso) setDue(iso);
            setError('');
          }}
          onFocus={() => {}}
          active
          error={error}
          placeholder={numeric.pattern}>
          <Select
            className="cd-date-time"
            aria-label={t('cd.dueTime')}
            value={String(time)}
            disabled={!on}
            onChange={event => setTime(Number(event.target.value))}
            options={dueTimeOptions(locale, time)}
          />
        </DateField>
        <label className="cd-pop-label" htmlFor={`cd-item-remind-${idKey}`}>
          {t('cd.remindLabel')}
        </label>
        <Select
          id={`cd-item-remind-${idKey}`}
          value={remind === null ? 'none' : String(remind)}
          disabled={!on}
          onChange={event => setRemind(event.target.value === 'none' ? null : Number(event.target.value))}
          options={remindOptions(t)}
        />
        <p className="cd-pop-note">{t('cd.itemRemindNote')}</p>
        {status && (
          <p className="field-error" role="alert">
            {status}
          </p>
        )}
        <Button type="submit" className="cd-pop-wide" pending={pending === 'save'} pendingLabel={t('common.saving')} disabled={pending !== null || blocked}>
          {t('common.save')}
        </Button>
        <Button
          variant="secondary"
          className="cd-pop-wide"
          pending={pending === 'remove'}
          pendingLabel={t('cd.removing')}
          disabled={pending !== null || blocked || !item.dueDate}
          onClick={() => void write('remove', NO_DUE)}>
          {t('cd.remove')}
        </Button>
      </form>
    </Popover>
  );
}

/** The item's due chip text: "Nov 6" for a day, "Nov 6, 3:00 PM" with a time (in the person's zone). */
function useItemDueLabel(item: ItemDue) {
  const {formatDate} = useI18n();
  if (!item.dueDate) return '';
  if (item.dueAt)
    return formatDate(item.dueAt, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  return formatDate(`${item.dueDate}T00:00:00Z`, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
/** Past due: the moment has passed (timed), or the day is before today (day only). Ticked items are never late. */
const isOverdue = (item: ItemT) => !item.done && item.dueDate !== null && (item.dueAt ? new Date(item.dueAt).getTime() < Date.now() : item.dueDate < todayISO());

/**
 * Who and when for one item, at the end of its row (Trello): an avatar and a date chip once set; for editors the
 * assign and due-date buttons, which show on hover or focus while empty.
 */
function ItemMeta({item, cardId, canWrite, busy, run, actions}: {item: ItemT; cardId: number; canWrite: boolean; busy: string | null; run: Run; actions: CardActions}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const dueAnchor = useRef<HTMLButtonElement>(null);
  const overdue = isOverdue(item);
  const dueLabel = useItemDueLabel(item);
  const who = item.assignee ? item.assignee.name || t('cd.deletedUser') : '';
  const mine = busy === `item-${item.id}`;
  if (!canWrite) {
    if (!item.assignee && !item.dueDate) return null;
    return (
      <span className="cd-item-meta">
        {item.dueDate && (
          <span className="cd-item-chip" data-overdue={overdue ? '' : undefined}>
            <Icon name="clock" size={14} />
            {dueLabel}
            {overdue && <span className="sr-only"> ({t('card.overdue')})</span>}
          </span>
        )}
        {item.assignee && (
          <span className="cd-item-avatar" title={who}>
            <Avatar name={who} size="sm" />
            <span className="sr-only">{who}</span>
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="cd-item-meta">
      <span className="cd-item-due" data-set={item.dueDate ? '' : undefined} data-overdue={overdue ? '' : undefined}>
        <button
          ref={dueAnchor}
          type="button"
          className="picker-trigger cd-item-due-btn"
          aria-haspopup="dialog"
          aria-expanded={dueOpen}
          aria-label={item.dueDate ? `${t('cd.itemDueTitle')}: ${dueLabel}${overdue ? ` (${t('card.overdue')})` : ''}` : t('cd.itemDue')}
          title={item.dueDate ? t('cd.itemDueTitle') : t('cd.itemDue')}
          disabled={busy !== null && !mine}
          onClick={() => setDueOpen(o => !o)}>
          <Icon name="clock" size={14} />
          {item.dueDate && <span>{dueLabel}</span>}
        </button>
      </span>
      {dueOpen && <ItemDuePop idKey={String(item.id)} item={item} onSave={due => actions.setItemDueTime(item.id, due)} anchor={dueAnchor} onClose={() => setDueOpen(false)} />}
      <button
        ref={anchor}
        type="button"
        className="cd-item-assign"
        data-set={item.assignee ? '' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={item.assignee ? t('cd.itemAssigned', {name: who}) : t('cd.itemAssign')}
        title={item.assignee ? who : t('cd.itemAssign')}
        disabled={busy !== null && !mine}
        onClick={() => setOpen(o => !o)}>
        {item.assignee ? <Avatar name={who} size="sm" /> : <Icon name="user-plus" size={16} />}
      </button>
      <PeoplePopover
        cardId={cardId}
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t('cd.itemAssign')}
        isOn={id => item.assignee?.id === id}
        disabled={busy !== null}
        // Picking the person who is already on the item takes them off.
        onPick={person => {
          setOpen(false);
          void run(`item-${item.id}`, () => actions.setItemAssignee(item.id, item.assignee?.id === person.id ? null : person));
        }}
      />
    </span>
  );
}

function Item({item, cardId, canWrite, busy, run, actions}: {item: ItemT; cardId: number; canWrite: boolean; busy: string | null; run: Run; actions: CardActions}) {
  const t = useT();
  const {blocked} = useWriteCooldown();
  const [editing, setEditing] = useState(usePeekDraft('itemedit', item.id));
  const mine = busy === `item-${item.id}`;
  if (editing) {
    return (
      <li className="cd-item" data-editing="">
        <InlineInput
          label={t('cd.itemEdit')}
          initial={item.text}
          max={300}
          draft={{kind: 'itemedit', id: item.id}}
          submitLabel={t('common.save')}
          pending={mine}
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={async text => {
            const ok = await run(`item-${item.id}`, () => actions.editItem(item.id, text));
            if (ok) setEditing(false);
            return ok;
          }}
        />
      </li>
    );
  }
  return (
    <li className="cd-item" data-done={item.done ? '' : undefined} aria-busy={mine || undefined}>
      {/* The box ticks; the text opens the edit field (Trello), so the text is not the checkbox's label.
          Ticking is optimistic, so only this row's own box waits for its save: the others stay usable and undimmed. */}
      <div className="checkbox cd-item-check" data-disabled={!canWrite || blocked ? '' : undefined}>
        <input
          type="checkbox"
          aria-label={item.text}
          checked={item.done}
          disabled={!canWrite || mine || blocked}
          onChange={event => void run(`item-${item.id}`, () => actions.toggleItem(item.id, event.target.checked))}
        />
        {canWrite ? (
          <button type="button" className="checkbox-label cd-item-text" title={t('cd.itemEdit')} disabled={mine} onClick={() => setEditing(true)}>
            {item.text}
          </button>
        ) : (
          <span className="checkbox-label">{item.text}</span>
        )}
      </div>
      <ItemMeta item={item} cardId={cardId} canWrite={canWrite} busy={busy} run={run} actions={actions} />
      {canWrite && (
        <Menu
          label={t('cd.itemActions', {text: item.text})}
          items={[
            {
              label: t('cd.itemEdit'),
              icon: 'pencil',
              onSelect: () => setEditing(true),
            },
            {
              label: t('cd.itemDelete'),
              icon: 'trash',
              danger: true,
              onSelect: () => void run(`item-${item.id}`, () => actions.deleteItem(item.id)),
            },
          ]}
        />
      )}
    </li>
  );
}

/**
 * Trello's "Add an item": a text box, Add and Cancel, and on the same row the person and the due date the new item
 * gets. Stays open after Add for the next item; Esc or Cancel closes it. Several pasted lines add several items.
 */
function ItemComposer({list, cardId, actions, onClose}: {list: ChecklistT; cardId: number; actions: CardActions; onClose: () => void}) {
  const t = useT();
  const {busy, run} = useAction();
  const {blocked} = useWriteCooldown();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [assignee, setAssignee] = useState<PersonT | null>(null);
  const [due, setDue] = useState<ItemDue>(NO_DUE);
  const [picking, setPicking] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const who = useRef<HTMLButtonElement>(null);
  const dueAnchor = useRef<HTMLButtonElement>(null);
  const dueLabel = useItemDueLabel(due);
  const input = useRef<HTMLTextAreaElement>(null);
  const clearDraft = useDraft('item', list.id, value, setValue, '', true);
  const errorId = useId();
  const pending = busy === 'add';
  const close = () => {
    clearDraft();
    onClose();
  };
  const submit = async (text: string) => {
    if (pending || blocked) return;
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return setError(t('cd.textRequired'));
    if (lines.some(line => line.length > 300)) return setError(t('cd.textTooLong', {max: 300}));
    setError('');
    const meta = {
      ...(assignee ? {assigneeId: assignee.id} : {}),
      ...(due.dueDate ? {dueDate: due.dueDate} : {}),
      ...(due.dueDate && due.dueAt ? {dueAt: due.dueAt, dueRemindMinutes: due.dueRemindMinutes} : {}),
    };
    // The server takes 20 per call: send every line in batches. A failed batch keeps the unsent lines in the box (the
    // sent ones are on the list), so a retry never duplicates and nothing typed is lost.
    let sent = 0;
    const ok = await run('add', async () => {
      for (; sent < lines.length; sent += 20) await actions.addItems(list.id, lines.slice(sent, sent + 20), meta);
    });
    if (ok) {
      clearDraft();
      setValue('');
    } else if (sent > 0) setValue(lines.slice(sent).join('\n'));
    // After the re-render that lifts `disabled` (a disabled box ignores focus), so the next item can be typed at once.
    requestAnimationFrame(() => input.current?.focus());
  };
  return (
    <>
      <form
        className="cd-item-composer"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          void submit(value);
        }}>
        <textarea
          ref={input}
          dir="auto"
          rows={2}
          value={value}
          aria-label={t('cd.itemText')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder={t('cd.addAnItem')}
          autoComplete="off"
          autoFocus
          disabled={pending}
          onChange={event => {
            setValue(event.target.value);
            if (error) setError('');
          }}
          onPaste={event => {
            const text = event.clipboardData.getData('text').trim();
            if (!text.includes('\n')) return;
            event.preventDefault();
            void submit(text);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit(value);
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              event.preventDefault(); // the modal's native Esc must not also fire
              close();
            }
          }}
        />
        {error && (
          <p id={errorId} className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="cd-item-composer-row">
          <Button type="submit" size="sm" disabled={blocked} pending={pending} pendingLabel={t('common.saving')}>
            {t('cd.add')}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={close}>
            {t('common.cancel')}
          </Button>
          <span className="cd-spacer" />
          <Button
            ref={who}
            size="sm"
            variant="secondary"
            icon={assignee ? undefined : 'user-plus'}
            aria-haspopup="dialog"
            aria-expanded={picking}
            disabled={pending}
            onClick={() => setPicking(o => !o)}>
            {assignee ? (
              <>
                <Avatar name={assignee.name || '?'} size="sm" />
                {assignee.name || t('cd.deletedUser')}
              </>
            ) : (
              t('cd.itemAssign')
            )}
          </Button>
          <PeoplePopover
            cardId={cardId}
            open={picking}
            onClose={() => setPicking(false)}
            anchor={who}
            label={t('cd.itemAssign')}
            isOn={id => assignee?.id === id}
            onPick={person => {
              setPicking(false);
              setAssignee(assignee?.id === person.id ? null : person);
            }}
          />
          <span className="cd-item-composer-due">
            <button
              ref={dueAnchor}
              id={`cd-new-item-due-${list.id}`}
              type="button"
              className="picker-trigger"
              aria-haspopup="dialog"
              aria-expanded={dueOpen}
              aria-label={due.dueDate ? `${t('cd.itemDueTitle')}: ${dueLabel}` : t('cd.itemDue')}
              disabled={pending}
              onClick={() => setDueOpen(o => !o)}>
              <Icon name="calendar" size={16} />
              <span className={due.dueDate ? 'picker-value' : 'picker-value picker-placeholder'}>{due.dueDate ? dueLabel : t('cd.itemDue')}</span>
            </button>
          </span>
        </div>
      </form>
      {/* Outside the composer's form: the popover has its own form (forms never nest). */}
      {dueOpen && <ItemDuePop idKey={`new-${list.id}`} item={due} onSave={setDue} anchor={dueAnchor} onClose={() => setDueOpen(false)} />}
    </>
  );
}

/**
 * Eases a number to its new value (~300 ms, ease-out) so the checklist's % bar and figure glide instead of jumping.
 * Starts at the first value (no animation on open) and jumps straight there under reduced motion.
 */
function useGlide(target: number, duration = 300) {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      current.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const next = from + (target - from) * (1 - (1 - t) ** 3);
      current.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return value;
}

/** One checklist as its own section (Trello): title, Hide checked items, Delete; a % bar; the items; "Add an item". */
function Checklist({list, cardId, canWrite, actions}: {list: ChecklistT; cardId: number; canWrite: boolean; actions: CardActions}) {
  const t = useT();
  const {formatNumber} = useI18n();
  const confirm = useConfirm();
  const {busy, run} = useAction();
  const [renaming, setRenaming] = useState(usePeekDraft('checklist', list.id));
  const [adding, setAdding] = useState(usePeekDraft('item', list.id));
  const [hideDone, setHideDone] = useState(false);
  const done = list.items.filter(i => i.done).length;
  const total = list.items.length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const shownPercent = useGlide(percent);
  const shown = hideDone ? list.items.filter(i => !i.done) : list.items;
  const headingId = `cd-checklist-${list.id}`;
  return (
    <section className="cd-section cd-checklist" data-checklist={list.id} aria-labelledby={headingId}>
      <div className="cd-section-head">
        <Icon name="check-square" size={18} />
        {renaming ? (
          <InlineInput
            label={t('cd.checklistRename')}
            initial={list.title}
            max={100}
            draft={{kind: 'checklist', id: list.id}}
            submitLabel={t('common.save')}
            pending={busy === 'rename'}
            autoFocus
            onCancel={() => setRenaming(false)}
            onSubmit={async title => {
              const ok = await run('rename', () => actions.renameChecklist(list.id, title));
              if (ok) setRenaming(false);
              return ok;
            }}
          />
        ) : (
          <>
            <h3 id={headingId}>
              {canWrite ? (
                <button type="button" className="cd-checklist-title" aria-label={`${t('cd.checklistRename')}: ${list.title}`} onClick={() => setRenaming(true)}>
                  {list.title}
                </button>
              ) : (
                list.title
              )}
            </h3>
            <span className="cd-spacer" />
            {done > 0 && (
              <Button size="sm" variant="secondary" aria-pressed={hideDone} onClick={() => setHideDone(v => !v)}>
                {hideDone ? t('cd.showChecked', {count: done}) : t('cd.hideChecked')}
              </Button>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() =>
                  void confirm({
                    title: t('cd.checklistDeleteTitle', {title: list.title}),
                    body: t('cd.checklistDeleteBody'),
                    confirmLabel: t('cd.checklistDelete'),
                    action: () => actions.deleteChecklist(list.id),
                  })
                }>
                {t('cd.delete')}
              </Button>
            )}
          </>
        )}
      </div>
      <div className="cd-progress" data-complete={total > 0 && done === total ? '' : undefined}>
        <span className="cd-progress-num">{formatNumber(Math.round(shownPercent) / 100, {style: 'percent'})}</span>
        <ProgressBar value={shownPercent} max={100} label={t('cd.checklistProgress', {done, total})} />
      </div>
      {hideDone && done === total && total > 0 && <p className="cd-none">{t('cd.allChecked')}</p>}
      <ul className="cd-items">
        {shown.map(item => (
          <Item key={item.id} item={item} cardId={cardId} canWrite={canWrite} busy={busy} run={run} actions={actions} />
        ))}
      </ul>
      {canWrite &&
        (adding ? (
          <ItemComposer list={list} cardId={cardId} actions={actions} onClose={() => setAdding(false)} />
        ) : (
          <div>
            <Button size="sm" variant="secondary" className="cd-add-item-open" onClick={() => setAdding(true)}>
              {t('cd.addAnItem')}
            </Button>
          </div>
        ))}
    </section>
  );
}

/** Every checklist of the card, each its own section. New ones come from the "Checklist" button under the title. */
export function Checklists({detail, actions}: {detail: DetailT; actions: CardActions}) {
  const {canWrite, checklists} = detail;
  if (checklists.length === 0) return null;
  return (
    <>
      {checklists.map(list => (
        <Checklist key={list.id} list={list} cardId={detail.card.id} canWrite={canWrite} actions={actions} />
      ))}
    </>
  );
}
