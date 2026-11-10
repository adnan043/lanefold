import {type RefObject, useEffect, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, Checkbox, Field, Icon, type IconName, IconButton, Select} from '../../portal/ui';
import {Chip} from '../../portal/ui/chips';
import {COLOR_PRESETS} from '../../portal/ui/contrast';
import {DatePicker, Popover} from '../../portal/ui/popover';
import {useAction} from './parts';
import type {CardActions, DetailT, FieldT, FieldType} from './use-card';

const TYPES: FieldType[] = ['dropdown', 'text', 'number', 'date', 'checkbox'];
/** The server's limits (src/server/field-shapes.ts FIELD_LIMITS). */
const FIELD_MAX = 20;
const OPTION_MAX = 30;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
/** Trello puts the field's kind in front of its name. */
const TYPE_ICON: Record<FieldType, IconName> = {dropdown: 'select-box', text: 'type', number: 'hash', date: 'calendar', checkbox: 'check-square'};

/** A field's name with its kind's icon; a `<label>` when it names one control. */
function FieldName({htmlFor, icon, children}: {htmlFor?: string; icon: IconName; children: string}) {
  const body = (
    <>
      <Icon name={icon} size={14} />
      <span>{children}</span>
    </>
  );
  return htmlFor ? (
    <label className="cd-field-name" htmlFor={htmlFor}>
      {body}
    </label>
  ) : (
    <span className="cd-field-name cd-label-text">{body}</span>
  );
}

/** The card's own Priority and Estimate, first in the Custom Fields grid. */
function BuiltInFields({detail, actions}: {detail: DetailT; actions: CardActions}) {
  const t = useT();
  const {busy, run} = useAction();
  const {card, canWrite} = detail;
  const saved = card.estimateMinutes === null ? '' : String(card.estimateMinutes);
  const [estimate, setEstimate] = useState(saved);
  const [estimateError, setEstimateError] = useState('');
  const estimateFocused = useRef(false);
  useEffect(() => {
    if (!estimateFocused.current) setEstimate(saved);
  }, [saved]);
  const saveEstimate = async () => {
    const raw = estimate.trim();
    const next = raw === '' ? null : Number(raw);
    if (next === card.estimateMinutes) return setEstimateError('');
    if (next !== null && (!Number.isInteger(next) || next < 1 || next > 99999)) return setEstimateError(t('cd.estimateInvalid'));
    setEstimateError('');
    if (!(await run('estimate', () => actions.patchDetails({estimateMinutes: next})))) setEstimate(saved);
  };
  return (
    <>
      <div className="cd-field">
        <FieldName htmlFor="cd-priority" icon="flag">
          {t('card.priority')}
        </FieldName>
        <Select
          id="cd-priority"
          value={card.priority}
          disabled={!canWrite || busy === 'priority'}
          onChange={event => void run('priority', () => actions.patchDetails({priority: event.target.value}))}
          options={PRIORITIES.map(p => ({value: p, label: p === 'none' ? t('cd.fieldSelect') : t(`card.priority.${p}` as 'card.priority.none')}))}
        />
      </div>
      {/* Not shown by default: only on a card that already has an estimate (so it can still be changed or cleared). */}
      {card.estimateMinutes !== null && (
        <div className="cd-field" data-invalid={estimateError ? '' : undefined}>
          <FieldName htmlFor="cd-estimate" icon="clock">
            {t('cd.estimate')}
          </FieldName>
          <input
            id="cd-estimate"
            placeholder={t('cd.estimatePlaceholder')}
            inputMode="numeric"
            value={estimate}
            readOnly={!canWrite}
            autoComplete="off"
            aria-invalid={estimateError ? true : undefined}
            aria-describedby={estimateError ? 'cd-estimate-error' : undefined}
            onChange={event => {
              setEstimate(event.target.value);
              if (estimateError) setEstimateError('');
            }}
            onFocus={() => {
              estimateFocused.current = true;
            }}
            onBlur={() => {
              estimateFocused.current = false;
              void saveEstimate();
            }}
            onKeyDown={event => event.key === 'Enter' && (event.preventDefault(), event.currentTarget.blur())}
          />
          {estimateError && (
            <p id="cd-estimate-error" className="field-error" role="alert">
              {estimateError}
            </p>
          )}
        </div>
      )}
    </>
  );
}
const typeLabel = (t: ReturnType<typeof useT>, type: FieldType) =>
  t(({dropdown: 'cd.fieldTypeDropdown', text: 'cd.fieldTypeText', number: 'cd.fieldTypeNumber', date: 'cd.fieldTypeDate', checkbox: 'cd.fieldTypeCheckbox'} as const)[type]);

/** A text or number box that saves on Enter or blur when the value changed. */
function TextValue({field, stored, canWrite, actions}: {field: FieldT; stored: string; canWrite: boolean; actions: CardActions}) {
  const t = useT();
  const {run} = useAction();
  const [value, setValue] = useState(stored);
  const [error, setError] = useState('');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setValue(stored);
  }, [stored]);
  const save = async () => {
    const raw = value.trim();
    if (raw === stored) return setError('');
    let next: string | number | null = raw === '' ? null : raw;
    if (field.type === 'number' && next !== null) {
      const n = Number(raw);
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) return setError(t('cd.fieldNumberInvalid'));
      next = n;
    }
    if (field.type === 'text' && raw.length > 200) return setError(t('cd.descriptionTooLong'));
    setError('');
    if (!(await run(`field-${field.id}`, () => actions.setFieldValue(field.id, next)))) setValue(stored);
  };
  const errorId = `cd-field-${field.id}-error`;
  return (
    <>
      <input
        id={`cd-field-${field.id}`}
        dir="auto"
        value={value}
        readOnly={!canWrite}
        maxLength={field.type === 'text' ? 200 : 20}
        placeholder={t(field.type === 'number' ? 'cd.fieldAddNumber' : 'cd.fieldAddText')}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={event => {
          setValue(event.target.value);
          if (error) setError('');
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          void save();
        }}
        onKeyDown={event => event.key === 'Enter' && (event.preventDefault(), event.currentTarget.blur())}
      />
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function FieldControl({field, detail, actions}: {field: FieldT; detail: DetailT; actions: CardActions}) {
  const t = useT();
  const {locale, firstDayOfWeek} = useI18n();
  const {busy, run} = useAction();
  const {canWrite} = detail;
  const stored = detail.fieldValues[String(field.id)];
  const pending = busy === `field-${field.id}`;
  const set = (value: string | number | boolean | null) => void run(`field-${field.id}`, () => actions.setFieldValue(field.id, value));
  if (field.type === 'checkbox') {
    return (
      <div className="cd-field">
        <FieldName icon={TYPE_ICON.checkbox}>{field.name}</FieldName>
        <Checkbox label={<span className="sr-only">{field.name}</span>} checked={stored === true} disabled={!canWrite || pending} onChange={set} />
      </div>
    );
  }
  return (
    <div className="cd-field">
      <FieldName htmlFor={`cd-field-${field.id}`} icon={TYPE_ICON[field.type]}>
        {field.name}
      </FieldName>
      {field.type === 'dropdown' ? (
        <Select
          id={`cd-field-${field.id}`}
          value={typeof stored === 'number' ? String(stored) : ''}
          placeholder={t('cd.fieldSelect')}
          disabled={!canWrite || pending}
          onChange={event => set(event.target.value === '' ? null : Number(event.target.value))}
          options={[{value: '', label: t('cd.fieldSelect')}, ...field.options.map(o => ({value: String(o.id), label: o.name}))]}
        />
      ) : field.type === 'date' ? (
        <DatePicker
          id={`cd-field-${field.id}`}
          value={typeof stored === 'string' ? stored : ''}
          label={field.name}
          clearable
          disabled={!canWrite || pending}
          locale={locale}
          firstDayOfWeek={firstDayOfWeek as 0}
          placeholder={t('cd.fieldAddDate')}
          onChange={iso => set(iso || null)}
        />
      ) : (
        <TextValue field={field} stored={stored === undefined ? '' : String(stored)} canWrite={canWrite} actions={actions} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the manager popover */

type View = {kind: 'list'} | {kind: 'new'} | {kind: 'edit'; id: number} | {kind: 'delete'; id: number};
type NewField = {name: string; type: FieldType; options: {name: string; colorHex: string}[]};

const colorAt = (i: number) => COLOR_PRESETS[i % COLOR_PRESETS.length]!;

/** Ready-made fields offered under the list (Trello's "Suggested fields"), hidden once the board has one by that name. */
function useSuggestions(): NewField[] {
  const t = useT();
  const levels = [t('card.priority.low'), t('card.priority.medium'), t('card.priority.high')];
  return [
    {name: t('cd.suggestEffort'), type: 'number', options: []},
    {name: t('cd.suggestStoryPoints'), type: 'number', options: []},
    {name: t('cd.suggestRisk'), type: 'dropdown', options: levels.map((name, i) => ({name, colorHex: colorAt(i)}))},
  ];
}

/** The popover's title bar: a back arrow on sub-views, the name centred, a close button at the end. */
function ManagerHead({title, onBack, onClose}: {title: string; onBack?: () => void; onClose: () => void}) {
  const t = useT();
  return (
    <div className="cd-pop-head">
      {onBack ? <IconButton icon="chevron-left" size="sm" label={t('common.back')} onClick={onBack} /> : <span className="cd-pop-head-pad" aria-hidden="true" />}
      <strong>{title}</strong>
      <IconButton icon="x" size="sm" label={t('common.close')} onClick={onClose} />
    </div>
  );
}

/** `ids` with `id` moved to `to` (an index in the same list). */
const moved = (ids: number[], id: number, to: number) => {
  const rest = ids.filter(x => x !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  return rest;
};

/** The board's fields: drag a row by its grip (or press ↑ ↓ on it) to reorder, open a row to edit it. */
function FieldList({detail, actions, onOpen, onNew}: {detail: DetailT; actions: CardActions; onOpen: (id: number) => void; onNew: () => void}) {
  const t = useT();
  const {busy, run} = useAction();
  const fields = detail.fields;
  const [dragId, setDragId] = useState<number | null>(null);
  const [preview, setPreview] = useState<number[] | null>(null);
  const byId = new Map(fields.map(f => [f.id, f]));
  const shown = (preview ?? fields.map(f => f.id)).map(id => byId.get(id)).filter((f): f is FieldT => !!f);
  const commit = (ids: number[]) => {
    const same = ids.length === fields.length && ids.every((id, i) => id === fields[i]!.id);
    if (!same) void run('reorder', () => actions.reorderFields(ids));
  };
  const suggestions = useSuggestions();
  const taken = new Set(fields.map(f => f.name.trim().toLowerCase()));
  const offered = suggestions.filter(s => !taken.has(s.name.toLowerCase()));
  const full = fields.length >= FIELD_MAX;
  return (
    <>
      <p className="cd-fm-hint">{t('cd.fieldsPopHint')}</p>
      {shown.length > 0 && (
        <ol className="cd-fm-list" aria-busy={busy === 'reorder' || undefined}>
          {shown.map((f, index) => (
            <li
              key={f.id}
              className="cd-fm-row"
              data-dragging={dragId === f.id ? '' : undefined}
              draggable={busy === null}
              onDragStart={event => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(f.id));
                setDragId(f.id);
                setPreview(fields.map(x => x.id));
              }}
              onDragOver={event => {
                if (dragId === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (dragId !== f.id && preview) setPreview(moved(preview, dragId, index));
              }}
              onDrop={event => event.preventDefault()}
              onDragEnd={() => {
                if (preview) commit(preview);
                setDragId(null);
                setPreview(null);
              }}>
              <button
                type="button"
                className="cd-fm-grip"
                aria-label={t('cd.fieldMove', {name: f.name})}
                title={t('cd.fieldMove', {name: f.name})}
                disabled={busy !== null}
                onKeyDown={event => {
                  const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                  if (!step) return;
                  event.preventDefault();
                  const to = index + step;
                  if (to < 0 || to >= fields.length) return;
                  const target = event.currentTarget;
                  void run('reorder', () => actions.reorderFields(moved(fields.map(x => x.id), f.id, to))).then(() =>
                    // The row re-renders in its new place: keep the keyboard on its grip.
                    window.requestAnimationFrame(() => target.closest('ol')?.querySelectorAll<HTMLElement>('.cd-fm-grip')[to]?.focus())
                  );
                }}>
                <Icon name="grip" size={16} />
              </button>
              <button type="button" className="cd-fm-open" onClick={() => onOpen(f.id)}>
                <Icon name={TYPE_ICON[f.type]} size={16} />
                <span className="cd-fm-name">{f.name}</span>
                <Icon name="chevron-right" size={16} />
              </button>
            </li>
          ))}
        </ol>
      )}
      {offered.length > 0 && !full && (
        <>
          <p className="cd-pop-sub">{t('cd.fieldsSuggested')}</p>
          <ul className="cd-fm-suggest">
            {offered.map(s => (
              <li key={s.name}>
                <span className="cd-fm-suggest-name">
                  <Icon name={TYPE_ICON[s.type]} size={16} />
                  <span>{s.name}</span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`${t('cd.fieldSuggestAdd')} ${s.name}`}
                  pending={busy === `suggest-${s.name}`}
                  disabled={busy !== null}
                  onClick={() => void run(`suggest-${s.name}`, () => actions.createField(s))}>
                  {t('cd.fieldSuggestAdd')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button size="sm" variant="secondary" icon="plus" className="cd-pop-wide" disabled={full || busy !== null} onClick={onNew}>
        {t('cd.fieldNew')}
      </Button>
      {full && <p className="cd-pop-note">{t('cd.fieldsLimit', {max: String(FIELD_MAX)})}</p>}
    </>
  );
}

/** A dropdown's options while the field is being built (nothing is sent until Create). */
function DraftOptions({value, onChange}: {value: string[]; onChange: (next: string[]) => void}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const add = () => {
    const name = draft.trim().slice(0, 40);
    if (!name) return;
    if (!value.some(o => o.toLowerCase() === name.toLowerCase()) && value.length < OPTION_MAX) onChange([...value, name]);
    setDraft('');
  };
  return (
    <div className="cd-fm-options">
      <p className="cd-pop-label">{t('cd.fieldOptionsTitle')}</p>
      {value.length > 0 && (
        <div className="cd-chips">
          {value.map((o, i) => (
            <Chip key={o} color={colorAt(i)} size="sm" removeLabel={t('cd.optionDelete', {name: o})} onRemove={() => onChange(value.filter(x => x !== o))}>
              {o}
            </Chip>
          ))}
        </div>
      )}
      <div className="cd-option-add">
        <input
          value={draft}
          maxLength={40}
          autoComplete="off"
          aria-label={t('cd.optionName')}
          placeholder={t('cd.optionName')}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && (event.preventDefault(), add())}
        />
        <Button size="sm" variant="secondary" icon="plus" disabled={!draft.trim() || value.length >= OPTION_MAX} onClick={add}>
          {t('cd.optionAdd')}
        </Button>
      </div>
    </div>
  );
}

/** "New field": a title and a type (dropdowns also take their options), then Create. */
function NewFieldForm({actions, onDone}: {actions: CardActions; onDone: () => void}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType | ''>('');
  const [options, setOptions] = useState<string[]>([]);
  const [errors, setErrors] = useState<{name?: string; type?: string}>({});
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const types = TYPES.map(v => ({value: v, label: typeLabel(t, v)})).sort((a, b) => a.label.localeCompare(b.label));
  const check = () => {
    const trimmed = name.trim();
    const next: typeof errors = {};
    if (!trimmed) next.name = t('cd.fieldNameRequired');
    else if (trimmed.length > 40) next.name = t('cd.fieldNameTooLong');
    if (!type) next.type = t('cd.fieldTypeRequired');
    return next;
  };
  const submit = async () => {
    const found = check();
    setErrors(found);
    if (found.name) return document.getElementById('nf-title')?.focus();
    if (found.type || !type) return document.getElementById('nf-type')?.focus();
    setStatus('');
    setPending(true);
    try {
      await actions.createField({name: name.trim(), type, options: type === 'dropdown' ? options.map((o, i) => ({name: o, colorHex: colorAt(i)})) : []});
      onDone();
    } catch (error) {
      setStatus(errorMessage(error));
      setPending(false);
    }
  };
  return (
    <form
      className="cd-pop-form"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}>
      <Field id="nf-title" label={t('cd.fieldTitle')} error={errors.name}>
        <input
          value={name}
          maxLength={80}
          autoComplete="off"
          placeholder={t('cd.fieldTitlePlaceholder')}
          data-autofocus
          onChange={event => {
            setName(event.target.value);
            if (errors.name) setErrors(e => ({...e, name: check().name}));
          }}
          onBlur={() => name && setErrors(e => ({...e, name: check().name}))}
        />
      </Field>
      <Field id="nf-type" label={t('cd.fieldType')} error={errors.type}>
        <Select
          id="nf-type"
          value={type}
          placeholder={t('cd.fieldSelect')}
          aria-invalid={errors.type ? true : undefined}
          aria-describedby={errors.type ? 'nf-type-error' : undefined}
          onChange={event => {
            setType(event.target.value as FieldType);
            setErrors(e => ({...e, type: undefined}));
          }}
          options={types}
        />
      </Field>
      {type === 'dropdown' && <DraftOptions value={options} onChange={setOptions} />}
      {status && (
        <p className="field-error" role="alert">
          {status}
        </p>
      )}
      <Button type="submit" size="sm" className="cd-pop-wide" pending={pending} pendingLabel={t('common.saving')}>
        {t('common.create')}
      </Button>
    </form>
  );
}

/** One field: its title (saved on Enter or leaving the box), its type, a dropdown's options, and Delete. */
function EditField({field, actions, onDelete}: {field: FieldT; actions: CardActions; onDelete: () => void}) {
  const t = useT();
  const {busy, run} = useAction();
  const [name, setName] = useState(field.name);
  const [error, setError] = useState('');
  const [option, setOption] = useState('');
  useEffect(() => setName(field.name), [field.name]);
  const rename = async () => {
    const next = name.trim();
    if (next === field.name) return setError('');
    if (!next) return setError(t('cd.fieldNameRequired'));
    if (next.length > 40) return setError(t('cd.fieldNameTooLong'));
    setError('');
    if (!(await run('rename', () => actions.renameField(field.id, next)))) setName(field.name);
  };
  const addOption = async () => {
    const text = option.trim().slice(0, 40);
    if (!text) return;
    if (await run('opt-add', () => actions.addOption(field.id, {name: text, colorHex: colorAt(field.options.length)}))) setOption('');
  };
  return (
    <div className="cd-pop-form">
      <Field id={`fe-title-${field.id}`} label={t('cd.fieldTitle')} error={error}>
        <input
          value={name}
          maxLength={80}
          autoComplete="off"
          placeholder={t('cd.fieldTitlePlaceholder')}
          data-autofocus
          disabled={busy === 'rename'}
          onChange={event => {
            setName(event.target.value);
            if (error) setError('');
          }}
          onBlur={() => void rename()}
          onKeyDown={event => event.key === 'Enter' && (event.preventDefault(), event.currentTarget.blur())}
        />
      </Field>
      <p className="cd-pop-label">{t('cd.fieldType')}</p>
      <p className="cd-fm-type">
        <Icon name={TYPE_ICON[field.type]} size={16} />
        <span>{typeLabel(t, field.type)}</span>
      </p>
      {field.type === 'dropdown' && (
        <div className="cd-fm-options">
          <p className="cd-pop-label">{t('cd.fieldOptionsTitle')}</p>
          {field.options.length > 0 && (
            <div className="cd-chips">
              {field.options.map(o => (
                <Chip key={o.id} color={o.colorHex} size="sm" removeLabel={t('cd.optionDelete', {name: o.name})} onRemove={busy === null ? () => void run(`opt-${o.id}`, () => actions.deleteOption(field.id, o.id)) : undefined}>
                  {o.name}
                </Chip>
              ))}
            </div>
          )}
          <form
            className="cd-option-add"
            noValidate
            onSubmit={event => {
              event.preventDefault();
              void addOption();
            }}>
            <input value={option} maxLength={40} autoComplete="off" aria-label={t('cd.optionName')} placeholder={t('cd.optionName')} onChange={event => setOption(event.target.value)} />
            <Button type="submit" size="sm" variant="secondary" icon="plus" pending={busy === 'opt-add'} disabled={!option.trim() || busy !== null || field.options.length >= OPTION_MAX}>
              {t('cd.optionAdd')}
            </Button>
          </form>
        </div>
      )}
      <hr className="cd-pop-rule" />
      <Button size="sm" variant="danger" icon="trash" className="cd-pop-wide" disabled={busy !== null} onClick={onDelete}>
        {t('cd.fieldDelete')}
      </Button>
    </div>
  );
}

/** Deleting asks once, in place (Trello): the values go from every card of the board. */
function DeleteField({field, actions, onDone}: {field: FieldT; actions: CardActions; onDone: () => void}) {
  const t = useT();
  const {busy, run} = useAction();
  return (
    <div className="cd-pop-form">
      <p className="cd-fm-hint">{t('cd.fieldDeleteBody')}</p>
      <Button
        variant="danger"
        size="sm"
        className="cd-pop-wide"
        data-autofocus
        pending={busy === 'delete'}
        pendingLabel={t('cd.fieldDeleting')}
        onClick={() => void run('delete', () => actions.deleteField(field.id)).then(ok => ok && onDone())}>
        {t('cd.fieldDelete')}
      </Button>
    </div>
  );
}

function FieldsManager({detail, actions, anchor, onClose}: {detail: DetailT; actions: CardActions; anchor: RefObject<HTMLElement | null>; onClose: () => void}) {
  const t = useT();
  const [view, setView] = useState<View>({kind: 'list'});
  const body = useRef<HTMLDivElement>(null);
  const field = view.kind === 'edit' || view.kind === 'delete' ? detail.fields.find(f => f.id === view.id) : undefined;
  // A field someone else deleted meanwhile: back to the list.
  const gone = (view.kind === 'edit' || view.kind === 'delete') && !field;
  useEffect(() => {
    if (gone) setView({kind: 'list'});
  }, [gone]);
  // Each step puts the keyboard on its first control (the Popover only does it when it opens).
  useEffect(() => {
    const box = body.current;
    if (!box) return;
    (box.querySelector<HTMLElement>('[data-autofocus]') ?? box.querySelector<HTMLElement>('button:not(:disabled), input'))?.focus();
  }, [view.kind]);
  const list = () => setView({kind: 'list'});
  const title =
    view.kind === 'new' ? t('cd.fieldNew') : view.kind === 'edit' ? t('cd.fieldEdit') : view.kind === 'delete' && field ? t('cd.fieldDeleteTitle', {name: field.name}) : t('cd.fields');
  return (
    <Popover open onClose={onClose} anchor={anchor} label={title} align="end" className="cd-pop cd-fm-pop">
      <ManagerHead title={title} onBack={view.kind === 'list' ? undefined : view.kind === 'delete' ? () => setView({kind: 'edit', id: view.id}) : list} onClose={onClose} />
      <div ref={body} className="cd-fm-body">
        {view.kind === 'list' && <FieldList detail={detail} actions={actions} onOpen={id => setView({kind: 'edit', id})} onNew={() => setView({kind: 'new'})} />}
        {view.kind === 'new' && <NewFieldForm actions={actions} onDone={list} />}
        {view.kind === 'edit' && field && <EditField key={field.id} field={field} actions={actions} onDelete={() => setView({kind: 'delete', id: field.id})} />}
        {view.kind === 'delete' && field && <DeleteField field={field} actions={actions} onDone={list} />}
      </div>
    </Popover>
  );
}

/** Trello's "Custom Fields": a collapsible grid of Priority (Estimate only once set) and every field the board defines; Edit opens the manager. */
export function CustomFields({detail, actions}: {detail: DetailT; actions: CardActions}) {
  const t = useT();
  const [managing, setManaging] = useState(false);
  const [open, setOpen] = useState(true);
  const edit = useRef<HTMLButtonElement>(null);
  const {canWrite, fields} = detail;
  return (
    <section className="cd-section cd-fields" aria-labelledby="cd-custom-fields">
      <div className="cd-section-head">
        <h3 id="cd-custom-fields">
          <button type="button" className="cd-collapse" aria-expanded={open} aria-controls="cd-fields-body" onClick={() => setOpen(v => !v)}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={18} />
            <span>{t('cd.fields')}</span>
          </button>
        </h3>
        <span className="cd-spacer" />
        {canWrite && (
          <Button ref={edit} id="cd-fields-edit" size="sm" variant="secondary" aria-haspopup="dialog" aria-expanded={managing} onClick={() => setManaging(v => !v)}>
            {t('cd.fieldsEdit')}
          </Button>
        )}
      </div>
      <div id="cd-fields-body" className="cd-props" hidden={!open}>
        <BuiltInFields detail={detail} actions={actions} />
        {fields.map(f => (
          <FieldControl key={f.id} field={f} detail={detail} actions={actions} />
        ))}
      </div>
      {canWrite && managing && <FieldsManager detail={detail} actions={actions} anchor={edit} onClose={() => setManaging(false)} />}
    </section>
  );
}
