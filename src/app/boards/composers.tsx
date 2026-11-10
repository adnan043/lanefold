import {useEffect, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button} from '../../portal/ui';
import {useWriteCooldown} from '../write-cooldown';

const MAX_CARDS = 20;
const MAX_TITLE = 200;

/** Lines of a paste or a typed block: one card per non-empty line. */
export function splitTitles(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

/** After a failed add: put the sent text back, unless the person has already typed something new. */
export function restoreText(current: string, sent: string): string {
  return current.trim() ? current : sent;
}

/** Inline "Add a card": Enter adds, Shift+Enter is a new line, several lines make several cards. */
export function CardComposer({onAdd, disabled, openRequest = 0}: {onAdd: (titles: string[], onFail?: () => void) => Promise<void>; disabled?: boolean; /** A number that goes up each time something else (the lane menu) asks the composer to open. */ openRequest?: number}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const cooldown = useWriteCooldown();
  const input = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useRef(`composer-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  const close = () => {
    setOpen(false);
    setText('');
    setError('');
    requestAnimationFrame(() => opener.current?.focus());
  };

  const submit = async () => {
    if (cooldown.blocked) return;
    const titles = splitTitles(text);
    if (titles.length === 0) return setError(t('card.titleRequired'));
    if (titles.length > MAX_CARDS) return setError(t('card.tooMany'));
    if (titles.some(title => title.length > MAX_TITLE)) return setError(t('card.titleTooLong'));
    setError('');
    setPending(true);
    try {
      const sent = text;
      await onAdd(titles, () => {
        setOpen(true);
        setText(current => restoreText(current, sent));
      });
      setText('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  if (!open) {
    return (
      <Button ref={opener} variant="ghost" size="sm" icon="plus" className="lf-add" data-shortcut="new" disabled={disabled} onClick={() => setOpen(true)}>
        {t('card.add')}
      </Button>
    );
  }
  return (
    <form
      className="lf-composer"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}>
      <label htmlFor={id} className="lf-composer-label">
        {t('card.addLabel')}
      </label>
      <textarea
        id={id}
        ref={input}
        dir="auto"
        rows={2}
        value={text}
        placeholder={t('card.addPlaceholder')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
        disabled={pending}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            close();
          }
        }}
      />
      <p className="field-hint" id={`${id}-hint`}>
        {t('card.addHint')}
      </p>
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      <div className="lf-composer-actions">
        <Button type="submit" size="sm" pending={pending} pendingLabel={t('card.adding')} disabled={cooldown.blocked}>
          {t('card.submit')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={close}>
          {t('card.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The "Add a lane" tile at the end of the board. */
export function LaneComposer({onAdd}: {onAdd: (name: string) => Promise<void>}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const cooldown = useWriteCooldown();
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useRef(`lane-composer-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setName('');
    setError('');
    requestAnimationFrame(() => opener.current?.focus());
  };

  const submit = async () => {
    if (cooldown.blocked) return;
    const value = name.trim();
    if (!value) return setError(t('lane.nameRequired'));
    if (value.length > 80) return setError(t('lane.nameTooLong'));
    setError('');
    setPending(true);
    try {
      await onAdd(value);
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <Button ref={opener} variant="secondary" icon="plus" className="lf-add-lane" onClick={() => setOpen(true)}>
        {t('lane.add')}
      </Button>
    );
  }
  return (
    <form
      className="lf-lane lf-lane-new"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}>
      <label htmlFor={id} className="lf-composer-label">
        {t('lane.name')}
      </label>
      <input
        id={id}
        ref={input}
        dir="auto"
        value={name}
        placeholder={t('lane.namePlaceholder')}
        autoComplete="off"
        disabled={pending}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => setName(event.target.value)}
        onKeyDown={event => event.key === 'Escape' && close()}
      />
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      <div className="lf-composer-actions">
        <Button type="submit" size="sm" pending={pending} pendingLabel={t('lane.adding')} disabled={cooldown.blocked}>
          {t('lane.submit')}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={close}>
          {t('card.cancel')}
        </Button>
      </div>
    </form>
  );
}
