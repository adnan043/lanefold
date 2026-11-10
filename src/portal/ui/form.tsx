import {
  type FormEvent,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
  cloneElement,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {type PasswordCheck} from '../../lib/password-checks';
import {type Rule, rules} from '../../lib/rules';
import {createPortal} from 'react-dom';

import {useCooldown} from './cooldown';
import {useUiLabels} from './labels';
import {Icon} from './icon';
import {portalHost} from './portal-host';

/**
 * Form controls. EVERY field in the portal uses these (AGENTS.md "Buttons and
 * forms"): a field always has a visible label and shows its own error in
 * place, in words, never a browser bubble. Text inputs and textareas are
 * plain `<input>` / `<textarea>` inside a `Field`, wired with
 * `{...form.field('name')}`; `.field` styles them.
 */

// ----------------------------------------------------------------- fields --

/**
 * One labelled field: the label, the control, a hint, and its error IN PLACE.
 * The control gets its wiring from `form.field(name)` (id, value, onChange,
 * onBlur, aria-invalid, aria-describedby).
 */
export function Field({
  label,
  hint,
  error,
  id,
  optional,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  id: string;
  optional?: boolean;
  children: ReactElement;
}) {
  const labels = useUiLabels();
  // A control that was not wired by `form.field()` still gets its id (so the label names it) and its error / hint
  // links; a control that sets its own keeps them.
  const own = children.props as {id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string};
  const wired = own.id
    ? children
    : cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
      });
  return (
    <div className="field" data-invalid={error ? '' : undefined}>
      <label htmlFor={id}>
        {label}
        {optional && <span className="muted"> ({labels.optional})</span>}
      </label>
      {wired}
      {hint && !error && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// -------------------------------------------------------------- passwords --

/**
 * A new-password input with a show / hide button. Spread `form.field(name)`
 * into it as into an `<input>`. Pair it with `PasswordChecks` so the rules
 * show while typing (`src/lib/password-checks.ts`).
 */
export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement> & {ref?: (node: HTMLInputElement | null) => void}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="pw-input">
      <input {...props} type={shown ? 'text' : 'password'} />
      <button
        className="pw-reveal"
        type="button"
        aria-controls={props.id}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown(value => !value)}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/** The live rules under a password field; missing ones turn red once `tried`. */
export function PasswordChecks({id, checks, tried}: {id: string; checks: PasswordCheck[]; tried?: boolean}) {
  return (
    <ul className="pw-checks" id={id} data-tried={tried ? '' : undefined}>
      {checks.map(check => (
        <li key={check.id} data-ok={check.ok ? '' : undefined}>
          {check.label}
          <span className="pw-checks-state">{check.ok ? ' (done)' : ' (not yet)'}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------- validation --

// Pure rules live in `src/lib/rules.ts` (shared with the website's forms).
export {rules, type Rule};

type Values = Record<string, string | boolean>;
type Schema<V extends Values> = Partial<Record<keyof V, Rule[]>>;
type Errors<V extends Values> = Partial<Record<keyof V, string>>;

/**
 * A small form state: values, per-field errors, when to show them.
 *
 * - An error shows after the field is left (blur) or after a submit attempt,
 *   never while the visitor is still typing their first value; once shown it
 *   updates on every keystroke, so it disappears the moment the value is right.
 * - `submit(onValid)` validates everything, shows every error, focuses the
 *   first wrong field, and only then calls `onValid`.
 * - `setServerErrors` puts the server's answer on the fields it names.
 */
export function useForm<V extends Values>(initial: V, schema: Schema<V>) {
  const [values, setValues] = useState<V>(initial);
  const [touched, setTouched] = useState<Partial<Record<keyof V, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<Errors<V>>({});
  const refs = useRef<Partial<Record<keyof V, HTMLElement | null>>>({});
  const cooldown = useCooldown();

  const check = (name: keyof V, all: V = values): string | undefined => {
    const value = all[name];
    if (typeof value !== 'string') return undefined;
    for (const rule of schema[name] ?? []) {
      const message = rule(value);
      if (message) return message;
    }
    return undefined;
  };
  const errorOf = (name: keyof V) =>
    touched[name] || submitted ? (server[name] ?? check(name)) : server[name];

  const set = <K extends keyof V>(name: K, value: V[K]) => {
    setValues(current => ({...current, [name]: value}));
    setServer(current => ({...current, [name]: undefined}));
  };

  /** Everything a text input, textarea or select needs. */
  const field = (name: keyof V & string) => {
    const error = errorOf(name);
    const id = `f-${name}`;
    return {
      id,
      name,
      value: String(values[name] ?? ''),
      ref: (node: HTMLElement | null) => {
        refs.current[name] = node;
      },
      onChange: (event: {target: {value: string}}) => set(name, event.target.value as V[typeof name]),
      onBlur: () => setTouched(current => ({...current, [name]: true})),
      'aria-invalid': error ? true : undefined,
      'aria-describedby': error ? `${id}-error` : `${id}-hint`,
    };
  };

  const submit = (onValid: (values: V) => void) => (event?: FormEvent) => {
    event?.preventDefault();
    if (cooldown.blocked) return;
    setSubmitted(true);
    const first = (Object.keys(schema) as (keyof V)[]).find(name => check(name));
    if (first) {
      refs.current[first]?.focus();
      return;
    }
    onValid(values);
  };

  const reset = (next: V = initial) => {
    setValues(next);
    setTouched({});
    setSubmitted(false);
    setServer({});
  };

  return {
    values,
    set,
    field,
    error: errorOf,
    submit,
    reset,
    setServerErrors: (errors: Errors<V>) => setServer(errors),
    /** True while a 429's `Retry-After` runs: put it in the submit button's `disabled`. Feed failures to `noteError`. */
    blocked: cooldown.blocked,
    noteError: cooldown.note,
  };
}

// ---------------------------------------------------------------- choices --

/**
 * A dropdown (every single choice in the app). It opens the same panel as `Menu`
 * (rounded, soft shadow, 36px rows, a check on the chosen one), never the
 * browser's native list. Spread `form.field(name)` into it like an `<input>`:
 * `onChange` gets `{target: {value}}`, so `event.target.value` works as before.
 * Keyboard: Enter / Space / ↓ open, ↑ ↓ Home End move, Enter picks, Esc closes.
 */
export function Select({
  options,
  value,
  onChange,
  disabled,
  id,
  className,
  placeholder,
  ref,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & {
  options: {value: string; label: string}[];
  value?: string | number;
  onChange?: (event: {target: {value: string; name?: string}; currentTarget: {value: string}}) => void;
  placeholder?: string;
  ref?: (node: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = String(value ?? '');
  const chosen = options.find(option => option.value === current);

  const items = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
  const focusItem = (index: number) => {
    const nodes = items();
    if (!nodes.length) return;
    nodes[(index + nodes.length) % nodes.length]?.focus({preventScroll: true});
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus({preventScroll: true});
  };
  const pick = (next: string) => {
    close();
    if (next !== current) onChange?.({target: {value: next, name: rest.name}, currentTarget: {value: next}});
  };

  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    const place = () => {
      const rect = button.current!.getBoundingClientRect();
      const menu = list.current!;
      menu.style.minWidth = `${rect.width}px`;
      const below = window.innerHeight - rect.bottom > Math.min(menu.offsetHeight, 280) + 12 || rect.top < menu.offsetHeight + 12;
      menu.style.top = `${Math.max(8, below ? rect.bottom + 6 : rect.top - menu.offsetHeight - 6)}px`;
      const rtl = getComputedStyle(menu).direction === 'rtl';
      const left = rtl ? rect.right - menu.offsetWidth : rect.left;
      menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8))}px`;
    };
    place();
    const nodes = items();
    const at = nodes.findIndex(node => node.getAttribute('aria-selected') === 'true');
    focusItem(at >= 0 ? at : 0);
    const outside = (event: PointerEvent) => {
      if (!list.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) close(false);
    };
    const away = (event?: Event) => {
      if (event?.target instanceof Node && list.current?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const at = items().indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') focusItem(at + 1);
    else if (event.key === 'ArrowUp') focusItem(at - 1);
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(items().length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      return close(true);
    } else if (event.key === 'Tab') {
      close(true);
      return;
    } else return;
    event.preventDefault();
  };

  return (
    <span className={className ? `select ${className}` : 'select'}>
      <button
        ref={node => {
          button.current = node;
          ref?.(node);
        }}
        type="button"
        id={id}
        className="input select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={rest['aria-label']}
        aria-labelledby={rest['aria-labelledby']}
        aria-describedby={rest['aria-describedby']}
        aria-invalid={rest['aria-invalid']}
        aria-busy={rest['aria-busy']}
        data-autofocus={(rest as {'data-autofocus'?: boolean | string})['data-autofocus']}
        onClick={() => setOpen(v => !v)}
        onBlur={rest.onBlur as unknown as undefined}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}>
        <span className="select-value">{chosen?.label ?? placeholder ?? ''}</span>
      </button>
      <Icon name="chevrons-up-down" size={16} className="select-chevron" />
      {open &&
        createPortal(
          <div ref={list} id={listId} className="menu menu-select" role="listbox" aria-label={rest['aria-label']} onKeyDown={onKeyDown}>
            {options.map(option => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === current}
                className="menu-item"
                tabIndex={-1}
                onClick={() => pick(option.value)}>
                <span className="menu-item-label">{option.label}</span>
                {option.value === current && <Icon name="check" size={16} className="menu-item-check" />}
              </button>
            ))}
          </div>,
          portalHost(button.current)
        )}
    </span>
  );
}

/** A checkbox with its label (and an optional line under it). */
export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox" data-disabled={disabled ? '' : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>
        <span className="checkbox-label">{label}</span>
        {description && <span className="checkbox-description">{description}</span>}
      </span>
    </label>
  );
}

/**
 * An on / off setting that applies AT ONCE (no Save button): "Remote",
 * "Email me a weekly summary". A choice that is saved with a form is a
 * `Checkbox`. While saving, pass `pending`: the switch is disabled.
 */
export function Switch({
  label,
  description,
  checked,
  onChange,
  disabled,
  pending,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <span className="switch-text">
        <span className="switch-label" id={`${id}-label`}>
          {label}
        </span>
        {description && (
          <span className="switch-description" id={`${id}-description`}>
            {description}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        aria-busy={pending || undefined}
        disabled={disabled || pending}
        onClick={() => onChange(!checked)}>
        <span className="switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Two to five choices, each one visible with a title, a line of explanation
 * and a tick on the picked one. Use it instead of a dropdown for short lists.
 */
export function RadioCards<V extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  columns = 2,
}: {
  legend: ReactNode;
  name: string;
  value: V;
  onChange: (value: V) => void;
  options: {value: V; title: ReactNode; description?: ReactNode; disabled?: boolean}[];
  columns?: 1 | 2 | 3 | 4;
}) {
  return (
    <fieldset className="radio-cards">
      <legend>{legend}</legend>
      <div className={`radio-cards-grid cols-${columns}`}>
        {options.map(option => (
          <label key={option.value} className="radio-card" data-disabled={option.disabled ? '' : undefined}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="radio-card-body">
              <span className="radio-card-title">{option.title}</span>
              {option.description && <span className="radio-card-description">{option.description}</span>}
            </span>
            <span className="radio-card-tick" aria-hidden="true">
              <Icon name="check" size={14} />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A search box for a toolbar: an icon, a visible-to-screen-readers label. */
export function SearchInput({label, ...props}: InputHTMLAttributes<HTMLInputElement> & {label: string}) {
  return (
    <span className="search-input">
      <Icon name="search" size={16} />
      <input type="search" aria-label={label} {...props} />
    </span>
  );
}
