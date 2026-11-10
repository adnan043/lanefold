import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {ColorDot} from './chips';
import {COLOR_PRESETS, isValidHex, normalizeHex} from './contrast';
import {addDays, addMonths, monthGrid, parseISODate, startOfWeek, todayISO, toISODate} from './date';
import {Icon} from './icon';
import {useUiLabels} from './labels';

// --------------------------------------------------------------- popover --

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /** The element the panel hangs from (its trigger button). Clicks on it are not "outside"; focus returns to it. */
  anchor: RefObject<HTMLElement | null>;
  /** Accessible name of the panel. */
  label: string;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
  /** Role of the panel; `dialog` for forms and pickers (default). */
  role?: 'dialog' | 'group';
};

/**
 * A small panel anchored to a trigger. Esc and a click outside close it,
 * focus moves in on open and returns to the trigger on close. Controlled:
 * the trigger sets `open` (give it `aria-haspopup="dialog"` and
 * `aria-expanded`). Placed with `element.style` (CSP-safe), flips above when
 * there is no room below, and closes on resize or when the page scrolls.
 */
export function Popover({open, onClose, anchor, label, children, align = 'start', className, role = 'dialog'}: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = anchor.current;
      const box = panel.current;
      if (!trigger || !box) return;
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom > box.offsetHeight + 12 || rect.top < box.offsetHeight + 12;
      const wanted = below ? rect.bottom + 6 : rect.top - box.offsetHeight - 6;
      // Keep the whole panel on screen: slide up when it would run past the bottom edge.
      box.style.top = `${Math.max(8, Math.min(wanted, window.innerHeight - box.offsetHeight - 8))}px`;
      const rtl = getComputedStyle(box).direction === 'rtl';
      // Left edge when the panel lines up with the trigger's left side, or with its right side.
      const fromLeft = rect.left;
      const fromRight = rect.right - box.offsetWidth;
      const fits = (left: number) => left >= 8 && left + box.offsetWidth <= window.innerWidth - 8;
      const wantsLeft = (align === 'start') !== rtl;
      // Use the other side when the asked-for one would run off screen (a right-aligned menu on the first lane would
      // otherwise be pushed to the left edge, under the sidebar).
      const left = wantsLeft ? (fits(fromLeft) || !fits(fromRight) ? fromLeft : fromRight) : fits(fromRight) || !fits(fromLeft) ? fromRight : fromLeft;
      box.style.left = `${Math.max(8, Math.min(left, window.innerWidth - box.offsetWidth - 8))}px`;
    };
    place();
    // Focus the first control (or the panel itself) so the keyboard is inside.
    const first =
      panel.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.current?.querySelector<HTMLElement>('input, button:not(:disabled), [tabindex="0"]');
    (first ?? panel.current)?.focus();

    const trigger = anchor.current;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      // A Select's option list is rendered outside the panel (portalHost): picking from it is not a click outside.
      if (target instanceof Element && target.closest('.menu-select')) return;
      if (!panel.current?.contains(target) && !trigger?.contains(target)) onCloseRef.current();
    };
    const away = (event: Event) => {
      if (event.type === 'scroll') {
        const target = event.target as Node;
        if (panel.current?.contains(target)) return;
        // Scrolling a Select's option list (rendered outside the panel, portalHost) is not the page scrolling.
        if (target instanceof Element && target.closest('.menu-select')) return;
      }
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
      // Focus goes back to the trigger unless the person already moved elsewhere (outside click on another control).
      const active = document.activeElement;
      if (!active || active === document.body || panel.current?.contains(active) || active === trigger) trigger?.focus();
    };
  }, [open, anchor, align]);

  if (!open) return null;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      // Tabbing out of the panel closes it (it is not a modal); focus continues from the trigger.
      const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]');
      const list = nodes ? [...nodes] : [];
      const edge = event.shiftKey ? list[0] : list[list.length - 1];
      if (!list.length || document.activeElement === edge || document.activeElement === panel.current) {
        onClose();
      }
    }
  };
  return (
    <div ref={panel} className={className ? `popover ${className}` : 'popover'} role={role} aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

// ----------------------------------------------------------- colour picker --

export type ColorPickerProps = {
  /** `#rrggbb`, or '' for none. */
  value: string;
  onChange: (hex: string) => void;
  label: string;
  /** Swatches; each must be `#rrggbb` (others are dropped). */
  presets?: readonly string[];
  disabled?: boolean;
  id?: string;
};

/**
 * A colour field: a button (sample + hex) opening a Popover with preset
 * swatches and a hex box. Only a strict `#rrggbb` is ever accepted, so the
 * value is safe to store and to use as a label colour.
 */
export function ColorPicker({value, onChange, label, presets = COLOR_PRESETS, disabled, id}: ColorPickerProps) {
  const labels = useUiLabels();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const button = useRef<HTMLButtonElement>(null);
  const hexId = useId();
  const current = normalizeHex(value);
  const swatches = useMemo(() => presets.filter(isValidHex), [presets]);
  const invalid = draft !== '' && !isValidHex(draft);

  useEffect(() => setDraft(value), [value, open]);

  const pick = (hex: string) => {
    onChange(hex.toLowerCase());
    setOpen(false);
  };
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className="picker-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${current ?? 'none'}`}
        onClick={() => setOpen(o => !o)}>
        {current ? <ColorDot color={current} /> : <Icon name="palette" size={16} />}
        <span className="picker-value">{current ?? 'Choose colour'}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={button} label={label} className="popover-color">
        <div className="swatch-grid" role="group" aria-label={labels.presetColours}>
          {swatches.map(hex => (
            <button key={hex} type="button" className="swatch" aria-label={hex} aria-pressed={current === hex.toLowerCase()} onClick={() => pick(hex)}>
              <ColorDot color={hex} size="lg" />
            </button>
          ))}
        </div>
        <div className="hex-row">
          <label htmlFor={hexId}>Hex</label>
          <input
            id={hexId}
            className="hex-input"
            value={draft}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            placeholder="#rrggbb"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${hexId}-err` : undefined}
            onChange={event => {
              const next = event.target.value.trim();
              setDraft(next);
              if (isValidHex(next)) onChange(next.toLowerCase());
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (isValidHex(draft)) setOpen(false);
              }
            }}
          />
          {draft !== '' && isValidHex(draft) && <ColorDot color={draft} />}
        </div>
        {invalid && (
          <p id={`${hexId}-err`} className="field-error" role="alert">
            Use six digits like #3b82f6.
          </p>
        )}
      </Popover>
    </>
  );
}

// ------------------------------------------------------------- date picker --

export type DatePickerProps = {
  /** ISO `yyyy-mm-dd`, or '' for no date. */
  value: string;
  onChange: (iso: string) => void;
  label: string;
  /** 0 Sunday (default) to 6 Saturday; 1 for Monday. */
  firstDayOfWeek?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** BCP 47 tag for month and day names; default the browser's. */
  locale?: string;
  /** Shows a "Clear" button, and the value may become ''. */
  clearable?: boolean;
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
};

export type CalendarProps = {
  /** The selected day, ISO `yyyy-mm-dd`, or ''. */
  value: string;
  onPick: (iso: string) => void;
  firstDayOfWeek?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  locale?: string;
  min?: string;
  max?: string;
  /** A span shown between two days (a start and a due date), both ends included. */
  range?: {from: string; to: string} | null;
  /** « and » buttons that move a year. */
  yearNav?: boolean;
  /** Focus the selected (or today's) day when the calendar mounts (the Popover does this for DatePicker). */
  autoFocusDay?: boolean;
};

/**
 * A month grid on its own (inline, no trigger). Arrow keys move a day / a week, PageUp / PageDown a month (Shift: a
 * year), Home / End the start / end of the week, Enter or Space picks. The value is always ISO.
 */
export function Calendar({value, onPick, firstDayOfWeek = 0, locale, min, max, range, yearNav, autoFocusDay = true}: CalendarProps) {
  const labels = useUiLabels();
  const grid = useRef<HTMLDivElement>(null);
  const selected = parseISODate(value) ? value : '';
  const today = todayISO();
  const [focused, setFocused] = useState(selected || today);
  const gridId = useId();
  // A value set from outside (a typed date) brings its month into view.
  useEffect(() => {
    if (selected) setFocused(selected);
  }, [selected]);

  const fmt = useMemo(() => {
    const month = new Intl.DateTimeFormat(locale, {month: 'long', year: 'numeric', timeZone: 'UTC'});
    const day = new Intl.DateTimeFormat(locale, {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'});
    const short = new Intl.DateTimeFormat(locale, {weekday: 'short', timeZone: 'UTC'});
    const long = new Intl.DateTimeFormat(locale, {weekday: 'long', timeZone: 'UTC'});
    return {month, day, short, long};
  }, [locale]);
  const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

  const p = parseISODate(focused) ?? parseISODate(today)!;
  const weeks = monthGrid(p.year, p.month, firstDayOfWeek);
  const weekStart = startOfWeek(toISODate(p.year, p.month, 1), firstDayOfWeek);
  const headers = Array.from({length: 7}, (_, i) => addDays(weekStart, i));
  const disabledDay = (iso: string) => (min !== undefined && iso < min) || (max !== undefined && iso > max);

  const move = (iso: string) => {
    if (disabledDay(iso)) return;
    setFocused(iso);
    // Focus follows after the grid re-renders.
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-date="${iso}"]`)?.focus());
  };
  const pick = (iso: string) => {
    if (disabledDay(iso)) return;
    setFocused(iso);
    onPick(iso);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, string> = {
      ArrowLeft: addDays(focused, -1),
      ArrowRight: addDays(focused, 1),
      ArrowUp: addDays(focused, -7),
      ArrowDown: addDays(focused, 7),
      PageUp: addMonths(focused, event.shiftKey ? -12 : -1),
      PageDown: addMonths(focused, event.shiftKey ? 12 : 1),
      Home: startOfWeek(focused, firstDayOfWeek),
      End: addDays(startOfWeek(focused, firstDayOfWeek), 6),
    };
    const next = step[event.key];
    if (!next) return;
    event.preventDefault();
    // RTL: the arrows follow reading direction.
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && getComputedStyle(event.currentTarget).direction === 'rtl') {
      return move(event.key === 'ArrowLeft' ? addDays(focused, 1) : addDays(focused, -1));
    }
    move(next);
  };
  const inRange = (iso: string) => !!range && range.from <= range.to && iso >= range.from && iso <= range.to;

  return (
    <div className="calendar">
      <div className="date-head">
        {yearNav && (
          <button type="button" className="date-nav" aria-label={labels.previousYear} onClick={() => setFocused(addMonths(focused, -12))}>
            <Icon name="chevrons-left" size={16} className="icon-flip" />
          </button>
        )}
        <button type="button" className="date-nav" aria-label={labels.previousMonth} onClick={() => setFocused(addMonths(focused, -1))}>
          <Icon name="chevron-left" size={16} className="icon-flip" />
        </button>
        <div className="date-title" id={`${gridId}-title`} aria-live="polite">
          {fmt.month.format(at(toISODate(p.year, p.month, 1)))}
        </div>
        <button type="button" className="date-nav" aria-label={labels.nextMonth} onClick={() => setFocused(addMonths(focused, 1))}>
          <Icon name="chevron-right" size={16} className="icon-flip" />
        </button>
        {yearNav && (
          <button type="button" className="date-nav" aria-label={labels.nextYear} onClick={() => setFocused(addMonths(focused, 12))}>
            <Icon name="chevrons-right" size={16} className="icon-flip" />
          </button>
        )}
      </div>
      <div ref={grid} role="grid" aria-labelledby={`${gridId}-title`} className="date-grid" onKeyDown={onKeyDown}>
        <div role="row" className="date-row">
          {headers.map(iso => (
            <span key={iso} role="columnheader" className="date-weekday" title={fmt.long.format(at(iso))}>
              {fmt.short.format(at(iso))}
            </span>
          ))}
        </div>
        {weeks.map(week => (
          <div role="row" className="date-row" key={week[0]}>
            {week.map(iso => {
              const outside = parseISODate(iso)!.month !== p.month;
              return (
                <span role="gridcell" key={iso} aria-selected={iso === selected}>
                  <button
                    type="button"
                    className="date-day"
                    data-date={iso}
                    data-autofocus={(autoFocusDay && iso === focused) || undefined}
                    data-outside={outside || undefined}
                    data-today={iso === today || undefined}
                    data-selected={iso === selected || undefined}
                    data-in-range={inRange(iso) || undefined}
                    tabIndex={iso === focused ? 0 : -1}
                    disabled={disabledDay(iso)}
                    aria-label={fmt.day.format(at(iso))}
                    aria-current={iso === today ? 'date' : undefined}
                    onClick={() => pick(iso)}>
                    {parseISODate(iso)!.day}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A date field: a button opening a Popover with a month grid (`Calendar`). Esc closes. The value is always ISO,
 * whatever the locale shows.
 */
export function DatePicker({value, onChange, label, firstDayOfWeek = 0, locale, clearable, min, max, placeholder = 'Pick a date', disabled, id}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const selected = parseISODate(value) ? value : '';
  const today = todayISO();
  const fmt = useMemo(
    () => ({
      full: new Intl.DateTimeFormat(locale, {dateStyle: 'medium', timeZone: 'UTC'}),
      day: new Intl.DateTimeFormat(locale, {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}),
    }),
    [locale]
  );
  const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const outOfBounds = (iso: string) => (min !== undefined && iso < min) || (max !== undefined && iso > max);
  const pick = (iso: string) => {
    if (outOfBounds(iso)) return;
    onChange(iso);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className="picker-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={selected ? `${label}: ${fmt.day.format(at(selected))}` : `${label}: none`}
        onClick={() => setOpen(o => !o)}>
        <Icon name="calendar" size={16} />
        <span className={selected ? 'picker-value' : 'picker-value picker-placeholder'}>{selected ? fmt.full.format(at(selected)) : placeholder}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={button} label={label} className="popover-date">
        <Calendar value={selected} onPick={pick} firstDayOfWeek={firstDayOfWeek} locale={locale} min={min} max={max} />
        <div className="date-foot">
          <button type="button" className="date-link" disabled={outOfBounds(today)} onClick={() => pick(today)}>
            Today
          </button>
          {clearable && selected && (
            <button
              type="button"
              className="date-link"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}>
              Clear
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}
