import {useEffect, useId, useState, useSyncExternalStore} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Avatar, Button, Field, Icon, Modal, SearchInput, useConfirm, useForm} from '../../portal/ui';
import {COLOR_PRESETS} from '../../portal/ui/contrast';
import {ColorPicker} from '../../portal/ui/popover';
import {Popover} from '../../portal/ui/popover';
import {useDraft} from '../use-draft';
import {type CardActions, type LabelT, type PersonT, usePeople} from './use-card';

/* ------------------------------------------------------------------ labels */

const SYMBOLS = ['●', '▲', '■', '◆', '★', '✚', '▼', '⬟'];
/** Colorblind-friendly mode: a shape per colour, so two labels never differ by hue alone. */
export const symbolOf = (hex: string) => SYMBOLS[[...hex].reduce((n, ch) => n + ch.charCodeAt(0), 0) % SYMBOLS.length]!;
const CB_KEY = 'lf_label_colorblind';
let cbOn: boolean | null = null;
const cbListeners = new Set<() => void>();
const readCb = () => {
  if (cbOn === null) {
    try {
      cbOn = localStorage.getItem(CB_KEY) === '1';
    } catch {
      cbOn = false;
    }
  }
  return cbOn;
};
const subscribeCb = (fn: () => void) => {
  cbListeners.add(fn);
  // Another tab changed it: follow along.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== CB_KEY) return;
    cbOn = e.newValue === '1';
    fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    cbListeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
};
const setCb = (value: boolean) => {
  cbOn = value;
  try {
    localStorage.setItem(CB_KEY, value ? '1' : '0');
  } catch {
    /* private mode: the choice lasts until the page reloads */
  }
  cbListeners.forEach(fn => fn());
};
/** A per-person display choice kept in this browser only, shared by every place that shows labels. */
export function useColorblind() {
  const on = useSyncExternalStore(subscribeCb, readCb, () => false);
  return [on, setCb] as const;
}

export function LabelDialog({target, actions, applyTo, onClose}: {target: LabelT | 'new' | null; actions: CardActions; applyTo: boolean; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const confirm = useConfirm();
  const label = target !== null && target !== 'new' ? target : null;
  const form = useForm({name: label?.name ?? ''}, {name: [rules.maxLength(40, t('cd.labelNameTooLong'))]});
  const [color, setColor] = useState<string>(label?.colorHex ?? COLOR_PRESETS[0]!);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (target === null) return;
    form.reset({name: label?.name ?? ''});
    setColor(label?.colorHex ?? COLOR_PRESETS[0]!);
    setStatus('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const [syncedTarget, setSyncedTarget] = useState<typeof target>(null);
  useEffect(() => setSyncedTarget(target), [target]);
  const clearDraft = useDraft('label', label?.id ?? 0, form.values.name, text => form.set('name', text), label?.name ?? '', target !== null && syncedTarget === target);
  const save = async () => {
    setPending(true);
    setStatus('');
    try {
      const input = {name: form.values.name.trim(), colorHex: color};
      if (label) await actions.updateLabel(label.id, input);
      else {
        const made = await actions.createLabel(input);
        if (applyTo) await actions.setLabel(made.id, true);
      }
      clearDraft();
      onClose();
    } catch (error) {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error) as never);
      setStatus(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      dismissible={!pending}
      title={label ? t('cd.labelEdit') : t('cd.labelNew')}
      footer={
        <>
          {label && (
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                void confirm({
                  title: t('cd.labelDeleteTitle', {name: label.name || label.colorHex}),
                  body: t('cd.labelDeleteBody'),
                  confirmLabel: t('cd.labelDelete'),
                  action: async () => {
                    await actions.deleteLabel(label.id);
                    onClose();
                  },
                })
              }>
              {t('cd.labelDelete')}
            </Button>
          )}
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="label-form" pending={pending} pendingLabel={t('common.saving')} disabled={form.blocked}>
            {t('common.save')}
          </Button>
        </>
      }>
      <form id="label-form" className="lf-form" noValidate onSubmit={form.submit(() => void save())}>
        <Field id="label-name" label={t('cd.labelName')} optional error={form.error('name')}>
          <input {...form.field('name')} autoComplete="off" maxLength={80} placeholder={t('cd.labelName')} />
        </Field>
        <div className="field">
          <span className="cd-label-text">{t('cd.labelColor')}</span>
          <ColorPicker value={color} onChange={setColor} label={t('cd.labelColor')} />
        </div>
        {status && (
          <p className="field-error" role="alert">
            {status}
          </p>
        )}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ people */

/** A searchable list of people who can be named on this card (names only; 20 at most, searched on the server). */
export function PeoplePopover({
  cardId,
  open,
  onClose,
  anchor,
  label,
  isOn,
  onPick,
  disabled,
}: {
  cardId: number;
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  label: string;
  isOn?: (id: number) => boolean;
  onPick: (person: PersonT) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(q.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [q]);
  const people = usePeople(cardId, debounced, open);
  const listId = useId();
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} label={label} className="cd-pop">
      <SearchInput label={t('cd.peopleSearch')} placeholder={t('cd.peopleSearch')} value={q} onChange={event => setQ(event.target.value)} autoComplete="off" data-autofocus />
      <ul className="cd-pick-list" id={listId} aria-busy={people.isFetching || undefined}>
        {(people.data?.items ?? []).map(p => {
          const on = isOn?.(p.id) ?? p.assigned;
          return (
            <li key={p.id}>
              <button type="button" className="cd-pick" aria-pressed={isOn ? on : undefined} disabled={disabled} onClick={() => onPick({id: p.id, name: p.name})}>
                <Avatar name={p.name} size="sm" />
                <span className="cd-pick-name">{p.name}</span>
                {on && <Icon name="check" size={16} />}
              </button>
            </li>
          );
        })}
      </ul>
      {people.isError && (
        <p className="field-error" role="alert">
          {t('states.loadError')}
        </p>
      )}
      {people.data && people.data.items.length === 0 && <p className="cd-none">{t('cd.peopleEmpty')}</p>}
    </Popover>
  );
}
