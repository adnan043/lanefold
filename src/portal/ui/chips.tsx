import {type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState} from 'react';

import {isValidHex, readableOn} from './contrast';
import {Avatar} from './display';
import {Icon} from './icon';

/**
 * Chips (labels in any colour), a chip input, a colour dot and the avatar
 * stack. A user-chosen colour is DATA, not a theme colour: it reaches the
 * element as CSS custom properties set through `element.style` (the CSP
 * blocks `style=""`), and only after `isValidHex`, so no raw CSS gets in.
 */

/** Sets `--chip-bg` / `--chip-ink` on an element from a validated hex. */
function useChipColor<T extends HTMLElement>(color?: string) {
  const ref = useRef<T>(null);
  const valid = color && isValidHex(color) ? color : null;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (valid) {
      el.style.setProperty('--chip-bg', valid);
      el.style.setProperty('--chip-ink', readableOn(valid));
    } else {
      el.style.removeProperty('--chip-bg');
      el.style.removeProperty('--chip-ink');
    }
  }, [valid]);
  return {ref, colored: valid !== null};
}

/** A round colour sample (decorative). */
export function ColorDot({color, size = 'md'}: {color: string; size?: 'sm' | 'md' | 'lg'}) {
  const {ref} = useChipColor<HTMLSpanElement>(color);
  return <span ref={ref} className={`color-dot color-dot-${size}`} aria-hidden="true" />;
}

export type ChipProps = {
  children: ReactNode;
  /** Any `#rrggbb`; text colour is picked for contrast. Omitted or invalid: the neutral chip. */
  color?: string;
  /** Shows a remove (x) button. */
  onRemove?: () => void;
  /** What the remove button says to a screen reader ("Remove label Bug"). */
  removeLabel?: string;
  size?: 'sm' | 'md';
  className?: string;
};

export function Chip({children, color, onRemove, removeLabel, size = 'md', className}: ChipProps) {
  const {ref, colored} = useChipColor<HTMLSpanElement>(color);
  const classes = ['chip', `chip-${size}`, colored ? 'chip-colored' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span ref={ref} className={classes}>
      <span className="chip-label">{children}</span>
      {onRemove && (
        <button type="button" className="chip-remove" aria-label={removeLabel ?? 'Remove'} onClick={onRemove}>
          <Icon name="x" size={14} />
        </button>
      )}
    </span>
  );
}

export type ChipInputProps = {
  /** Accessible name of the field (also the visible placeholder's meaning). */
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Hex per label (a saved label colour); default neutral. */
  colorFor?: (label: string) => string | undefined;
  /** Return an error message to refuse a new chip. */
  validate?: (label: string) => string | null;
  max?: number;
  disabled?: boolean;
};

/**
 * Type and press Enter or comma to add a chip, Backspace on the empty field
 * removes the last one. Duplicates (ignoring case) are skipped.
 */
export function ChipInput({label, value, onChange, placeholder, colorFor, validate, max, disabled}: ChipInputProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const full = max !== undefined && value.length >= max;

  const commit = () => {
    const text = draft.trim().replace(/,+$/, '').trim();
    if (!text) return setDraft('');
    if (full) return setError(`At most ${max}.`);
    const problem = validate?.(text) ?? null;
    if (problem) return setError(problem);
    setError(null);
    setDraft('');
    if (!value.some(v => v.toLowerCase() === text.toLowerCase())) onChange([...value, text]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="chip-input-wrap">
      {/* A click in the empty part of the box focuses the field. */}
      <div className="chip-input" aria-disabled={disabled || undefined} onClick={() => input.current?.focus()}>
        {value.map(chip => (
          <Chip
            key={chip}
            color={colorFor?.(chip)}
            removeLabel={`Remove ${chip}`}
            onRemove={disabled ? undefined : () => onChange(value.filter(v => v !== chip))}>
            {chip}
          </Chip>
        ))}
        <input
          ref={input}
          className="chip-input-field"
          value={draft}
          disabled={disabled || full}
          placeholder={value.length ? undefined : placeholder}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={event => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      </div>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export type AvatarStackPerson = {name: string; src?: string | null};

/** Overlapping avatars, first `max` shown (initials when no picture), then `+N`. */
export function AvatarStack({people, max = 4, size = 'sm', label}: {people: AvatarStackPerson[]; max?: number; size?: 'sm' | 'md' | 'lg'; label?: string}) {
  const shown = people.slice(0, Math.max(0, max));
  const rest = people.length - shown.length;
  const names = people.map(p => p.name).join(', ');
  return (
    <span className="avatar-stack" role="group" aria-label={label ?? (names || 'No people')}>
      {shown.map((person, i) => (
        <span key={`${person.name}-${i}`} className="avatar-stack-item" title={person.name}>
          <Avatar name={person.name} src={person.src} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span className={`avatar avatar-${size} avatar-more`} title={people.slice(shown.length).map(p => p.name).join(', ')}>
          +{rest}
        </span>
      )}
    </span>
  );
}
