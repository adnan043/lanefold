import {type FormEvent, useId, useRef, useState} from 'react';

import {useI18n, type MessageKey} from '../../i18n';
import {Button, Field, Icon, type IconName, IconButton, Select} from '../../portal/ui';
import {COLOR_PRESETS} from '../../portal/ui/contrast';
import {Popover} from '../../portal/ui/popover';
import type {LaneT} from '../api';
import './lane-menu.css';

export type SortBy = 'name' | 'newest' | 'oldest' | 'due';

/** What the lane menu can do. The board screen builds ONE of these (stable identity); the menu never talks to the server itself. */
export type LaneMenuApi = {
  /** The board's open lanes in order, read when the menu opens (so the lane handlers keep one identity). */
  lanes: () => LaneT[];
  move: (lane: LaneT, index: number) => void;
  /** These reject: the menu shows the server's reason next to the button. */
  copy: (lane: LaneT, name: string) => Promise<void>;
  moveCards: (lane: LaneT, toLaneId: number) => Promise<void>;
  sort: (lane: LaneT, by: SortBy) => Promise<void>;
  prefs: (lane: LaneT, patch: {pinned?: boolean; watching?: boolean}) => void;
  color: (lane: LaneT, hex: string | null) => void;
  archiveCards: (lane: LaneT) => void;
  archiveLane: (lane: LaneT) => void;
};

type View = 'main' | 'copy' | 'move' | 'moveCards' | 'sort';

const SORTS: {by: SortBy; label: MessageKey}[] = [
  {by: 'name', label: 'laneMenu.sortName'},
  {by: 'newest', label: 'laneMenu.sortNewest'},
  {by: 'oldest', label: 'laneMenu.sortOldest'},
  {by: 'due', label: 'laneMenu.sortDue'},
];

const VIEW_TITLE: Record<View, MessageKey> = {
  main: 'laneMenu.title',
  copy: 'laneMenu.copy',
  move: 'laneMenu.move',
  moveCards: 'laneMenu.moveCards',
  sort: 'laneMenu.sort',
};

/** The colour of a swatch is set through the CSSOM (the CSP blocks `style=""`). */
const swatch = (hex: string) => (node: HTMLElement | null) => node?.style.setProperty('--sw', hex);

/**
 * The "Lane actions" popover: add card, copy, move, move all cards, sort, pin, watch, colour swatches, archive.
 * One panel: choosing Copy / Move / Sort swaps its content (with a back arrow) instead of opening another popover.
 */
export function LaneMenu({lane, api}: {lane: LaneT; api: LaneMenuApi}) {
  const {t, errorMessage} = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('main');
  const [colorOpen, setColorOpen] = useState(true);
  const [lanes, setLanes] = useState<LaneT[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  const show = () => {
    setLanes(api.lanes());
    setView('main');
    setOpen(true);
  };
  const close = () => setOpen(false);
  /** Close first, then act: a confirmation dialog must not open under (or be closed by) the popover. */
  const run = (action: () => void) => () => {
    close();
    action();
  };

  const pinned = lane.pinned === true;
  const watching = lane.watching === true;

  return (
    <>
      <IconButton
        icon="more"
        size="sm"
        label={t('lane.menu', {name: lane.name})}
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : show())}
      />
      <Popover open={open} onClose={close} anchor={trigger} label={t('laneMenu.title')} align="start" className="lane-menu">
        <div className="lm-head" id={id}>
          {view !== 'main' ? (
            <IconButton icon="chevron-left" size="sm" label={t('laneMenu.back')} onClick={() => setView('main')} />
          ) : (
            <span className="lm-head-spacer" aria-hidden="true" />
          )}
          <h3 className="lm-title">{t(VIEW_TITLE[view])}</h3>
          <IconButton icon="x" size="sm" label={t('laneMenu.close')} onClick={close} />
        </div>

        {view === 'main' && (
          <div className="lm-body">
            <div className="lm-group">
              <Item icon="copy" label={t('laneMenu.copy')} onSelect={() => setView('copy')} more />
              <Item icon="arrow-right" label={t('laneMenu.move')} onSelect={() => setView('move')} more />
              <Item icon="chevrons-right" label={t('laneMenu.moveCards')} onSelect={() => setView('moveCards')} more />
              <Item icon="arrow-up-down" label={t('laneMenu.sort')} onSelect={() => setView('sort')} more />
              <Item
                icon="pin"
                label={pinned ? t('laneMenu.unpin') : t('laneMenu.pin')}
                pressed={pinned}
                onSelect={() => api.prefs(lane, {pinned: !pinned})}
              />
              <Item
                icon="eye"
                label={watching ? t('laneMenu.unwatch') : t('laneMenu.watch')}
                pressed={watching}
                onSelect={() => api.prefs(lane, {watching: !watching})}
              />
            </div>

            <div className="lm-rule" />
            <div className="lm-group">
              <button type="button" className="lm-section" aria-expanded={colorOpen} onClick={() => setColorOpen(v => !v)}>
                <span>{t('laneMenu.color')}</span>
                <Icon name={colorOpen ? 'chevron-up' : 'chevron-down'} size={16} />
              </button>
              {colorOpen && (
                <>
                  <div className="lm-swatches" role="group" aria-label={t('laneMenu.color')}>
                    {COLOR_PRESETS.map(hex => {
                      const selected = lane.colorHex?.toLowerCase() === hex;
                      return (
                        <button
                          key={hex}
                          type="button"
                          className="lm-swatch"
                          ref={swatch(hex)}
                          aria-pressed={selected}
                          aria-label={t('laneMenu.colorOption', {hex})}
                          onClick={() => api.color(lane, hex)}>
                          {selected && <Icon name="check" size={16} />}
                        </button>
                      );
                    })}
                  </div>
                  <button type="button" className="lm-remove" disabled={!lane.colorHex} onClick={() => api.color(lane, null)}>
                    <Icon name="x" size={14} />
                    {t('laneMenu.removeColor')}
                  </button>
                </>
              )}
            </div>

            <div className="lm-rule" />
            <div className="lm-group">
              <Item icon="archive" label={t('laneMenu.archiveLane')} danger onSelect={run(() => api.archiveLane(lane))} />
              <Item
                icon="archive"
                label={t('laneMenu.archiveCards')}
                danger
                disabled={lane.cardCount === 0}
                onSelect={run(() => api.archiveCards(lane))}
              />
            </div>
          </div>
        )}

        {view === 'copy' && (
          <CopyForm
            lane={lane}
            onSubmit={name => api.copy(lane, name)}
            onDone={() => {
              close();
            }}
            errorMessage={errorMessage}
          />
        )}
        {view === 'move' && <MoveForm lane={lane} lanes={lanes} onMove={index => api.move(lane, index)} onDone={close} />}
        {view === 'moveCards' && (
          <MoveCardsForm lane={lane} lanes={lanes} onSubmit={toLaneId => api.moveCards(lane, toLaneId)} onDone={close} errorMessage={errorMessage} />
        )}
        {view === 'sort' && <SortList lane={lane} onSort={by => api.sort(lane, by)} onDone={close} errorMessage={errorMessage} />}
      </Popover>
    </>
  );
}

function Item({
  icon,
  label,
  onSelect,
  danger,
  disabled,
  more,
  pressed,
}: {
  icon: IconName;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Opens a sub view of the panel. */
  more?: boolean;
  /** A switch (pin, watch): shows a check while on. */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={danger ? 'lm-item lm-item-danger' : 'lm-item'}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onSelect}>
      <Icon name={icon} size={16} />
      <span className="lm-item-label">{label}</span>
      {more && <Icon name="chevron-right" size={14} />}
      {pressed && <Icon name="check" size={16} />}
    </button>
  );
}

/** One line under a sub view's button: the server's reason, in words (never cleared input). */
function Status({error}: {error: string}) {
  return error ? (
    <p className="field-error" role="alert">
      {error}
    </p>
  ) : null;
}

function CopyForm({
  lane,
  onSubmit,
  onDone,
  errorMessage,
}: {
  lane: LaneT;
  onSubmit: (name: string) => Promise<void>;
  onDone: () => void;
  errorMessage: (error: unknown) => string;
}) {
  const {t} = useI18n();
  const id = useId();
  const [name, setName] = useState(() => t('laneMenu.copyDefault', {name: lane.name}).slice(0, 80));
  const [fieldError, setFieldError] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return setFieldError(t('lane.nameRequired'));
    if (clean.length > 80) return setFieldError(t('lane.nameTooLong'));
    setFieldError('');
    setStatus('');
    setPending(true);
    try {
      await onSubmit(clean);
      onDone();
    } catch (error) {
      setStatus(errorMessage(error));
      setPending(false);
    }
  };

  return (
    <form className="lm-body lm-form" noValidate onSubmit={submit}>
      <Field id={id} label={t('laneMenu.copyName')} error={fieldError} hint={t('laneMenu.copyHint')}>
        <input
          id={id}
          value={name}
          dir="auto"
          autoComplete="off"
          maxLength={200}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-error` : `${id}-hint`}
          data-autofocus
          onChange={event => {
            setName(event.target.value);
            if (fieldError) setFieldError('');
          }}
        />
      </Field>
      <Status error={status} />
      <Button type="submit" pending={pending} pendingLabel={t('laneMenu.copying')} disabled={pending}>
        {t('laneMenu.copySubmit')}
      </Button>
    </form>
  );
}

function MoveForm({lane, lanes, onMove, onDone}: {lane: LaneT; lanes: LaneT[]; onMove: (index: number) => void; onDone: () => void}) {
  const {t} = useI18n();
  const id = useId();
  const current = Math.max(
    0,
    lanes.findIndex(l => l.id === lane.id)
  );
  const [index, setIndex] = useState(current);
  const options = lanes.map((_, i) => ({
    value: String(i),
    label: i === current ? t('laneMenu.currentPosition', {n: i + 1, total: lanes.length}) : t('laneMenu.positionOption', {n: i + 1, total: lanes.length}),
  }));
  return (
    <form
      className="lm-body lm-form"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        onMove(index);
        onDone();
      }}>
      <Field id={id} label={t('laneMenu.position')}>
        <Select id={id} options={options} value={String(index)} data-autofocus onChange={event => setIndex(Number(event.target.value))} />
      </Field>
      <Button type="submit" disabled={index === current}>
        {t('laneMenu.moveSubmit')}
      </Button>
    </form>
  );
}

function MoveCardsForm({
  lane,
  lanes,
  onSubmit,
  onDone,
  errorMessage,
}: {
  lane: LaneT;
  lanes: LaneT[];
  onSubmit: (toLaneId: number) => Promise<void>;
  onDone: () => void;
  errorMessage: (error: unknown) => string;
}) {
  const {t} = useI18n();
  const id = useId();
  const others = lanes.filter(l => l.id !== lane.id);
  const [target, setTarget] = useState(others[0]?.id ?? 0);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const hint = others.length === 0 ? t('laneMenu.noOtherLane') : lane.cardCount === 0 ? t('laneMenu.noCards') : '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus('');
    setPending(true);
    try {
      await onSubmit(target);
      onDone();
    } catch (error) {
      setStatus(errorMessage(error));
      setPending(false);
    }
  };

  return (
    <form className="lm-body lm-form" noValidate onSubmit={submit}>
      <Field id={id} label={t('laneMenu.targetLane')} hint={hint || undefined}>
        <Select
          id={id}
          options={others.map(l => ({value: String(l.id), label: l.name}))}
          value={String(target)}
          disabled={others.length === 0 || pending}
          data-autofocus
          onChange={event => setTarget(Number(event.target.value))}
        />
      </Field>
      <Status error={status} />
      <Button type="submit" pending={pending} pendingLabel={t('laneMenu.moving')} disabled={pending || others.length === 0 || lane.cardCount === 0}>
        {t('laneMenu.moveCardsSubmit')}
      </Button>
    </form>
  );
}

function SortList({
  lane,
  onSort,
  onDone,
  errorMessage,
}: {
  lane: LaneT;
  onSort: (by: SortBy) => Promise<void>;
  onDone: () => void;
  errorMessage: (error: unknown) => string;
}) {
  const {t} = useI18n();
  const [busy, setBusy] = useState<SortBy | null>(null);
  const [status, setStatus] = useState('');

  const choose = async (by: SortBy) => {
    setStatus('');
    setBusy(by);
    try {
      await onSort(by);
      onDone();
    } catch (error) {
      setStatus(errorMessage(error));
      setBusy(null);
    }
  };

  return (
    <div className="lm-body">
      <div className="lm-group">
        {SORTS.map(option => (
          <button
            key={option.by}
            type="button"
            className="lm-item"
            disabled={busy !== null || lane.cardCount < 2}
            aria-busy={busy === option.by ? true : undefined}
            onClick={() => void choose(option.by)}>
            <span className="lm-item-label">{busy === option.by ? `${t(option.label)}…` : t(option.label)}</span>
          </button>
        ))}
      </div>
      <Status error={status} />
    </div>
  );
}
