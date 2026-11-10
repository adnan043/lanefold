import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import {useI18n, useT} from '../../i18n';
import {Button, Drawer, Field, IconButton, Notice, RadioCards, Select, Switch} from '../../portal/ui';
import {type ApiError} from '../api';
import type {FlowContext, Option} from './context';
import {
  ACTION_TYPES,
  type Draft,
  type DraftAction,
  emptyDraft,
  type ErrorCode,
  type Errors,
  type FlowInput,
  type FlowT,
  draftFromFlow,
  draftToInput,
  firstErrorField,
  MAX_ACTIONS,
  moveAction,
  newAction,
  serverErrors,
  TRIGGER_KINDS,
  validateDraft,
} from './logic';

const ERROR_KEY = {
  required: 'flows.err.required',
  too_long: 'flows.err.tooLong',
  invalid: 'flows.err.invalid',
  out_of_range: 'flows.err.outOfRange',
  not_found: 'flows.err.notFound',
  loop: 'flows.err.loop',
  too_many: 'flows.err.tooMany',
  no_actions: 'flows.err.noActions',
} as const satisfies Record<ErrorCode, string>;

/** The options plus the currently chosen value when it is no longer in the list (shown as "missing", never silently dropped). */
function withCurrent(options: Option[], value: string, missing: string): Option[] {
  return !value || options.some(o => o.value === value) ? options : [...options, {value, label: missing}];
}

const fieldId = (name: string) => `flow-${name.replace(/\./g, '-')}`;

/**
 * Create / edit one flow in a right Drawer. Rendered in a portal (it is opened from inside the board settings form, and a
 * form must not sit inside a form); its submit never reaches the settings form.
 */
export function FlowEditor({
  open,
  flow,
  context,
  onClose,
  onSave,
}: {
  open: boolean;
  /** `null` = create. */
  flow: FlowT | null;
  context: FlowContext;
  onClose: () => void;
  /** Sends the flow; throws the ApiError when the server refuses (its field errors land on the fields). */
  onSave: (input: FlowInput) => Promise<void>;
}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Errors>({});
  const [shown, setShown] = useState(false); // errors are shown after the first submit, then live
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(flow ? draftFromFlow(flow) : emptyDraft());
      setErrors({});
      setShown(false);
      setStatus('');
    }
    wasOpen.current = open;
  }, [open, flow]);

  const update = (patch: Partial<Draft>) => {
    const next = {...draft, ...patch};
    setDraft(next);
    if (shown) setErrors(validateDraft(next));
  };
  const updateAction = (key: number, patch: Partial<DraftAction>) => update({actions: draft.actions.map(a => (a.key === key ? {...a, ...patch} : a))});
  const message = (field: string) => (shown && errors[field] ? t(ERROR_KEY[errors[field]!], {max: MAX_ACTIONS}) : undefined);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const found = validateDraft(draft);
    setErrors(found);
    setShown(true);
    const first = firstErrorField(draft, found);
    if (first) {
      document.getElementById(fieldId(first))?.focus();
      return;
    }
    setPending(true);
    setStatus('');
    try {
      await onSave(draftToInput(draft));
    } catch (error) {
      const api = error as ApiError;
      const fromServer = serverErrors(api.fieldCodes);
      if (Object.keys(fromServer).length) {
        setErrors(fromServer);
        setShown(true);
        document.getElementById(fieldId(firstErrorField(draft, fromServer) ?? ''))?.focus();
      }
      setStatus(errorMessage(api));
    } finally {
      setPending(false);
    }
  };

  const laneOptions = (value: string) => withCurrent(context.lanes, value, t('flows.missing'));
  const labelOptions = (value: string) => withCurrent(context.labels, value, t('flows.missing'));
  const personOptions = (value: string) => withCurrent(context.people, value, t('flows.missing'));
  const anyLane = (value: string) => [{value: '', label: t('flows.anyLane')}, ...laneOptions(value)];
  const noLabelPicked = (value: string) => [{value: '', label: t('flows.anyCard')}, ...labelOptions(value)];

  const moveToLane = draft.kind === 'card_moved';

  const body = (
    <Drawer
      open={open}
      onClose={onClose}
      dismissible={!pending}
      title={flow ? t('flows.editTitle') : t('flows.newTitle')}
      description={t('flows.editorHint')}
      onSubmit={event => void submit(event)}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" pending={pending} pendingLabel={t('common.saving')}>
            {flow ? t('common.save') : t('flows.create')}
          </Button>
        </>
      }>
      <div className="lf-form lf-flow-form">
        <Field id={fieldId('name')} label={t('flows.nameLabel')} error={message('name')}>
          <input value={draft.name} onChange={e => update({name: e.target.value})} dir="auto" autoComplete="off" maxLength={200} placeholder={t('flows.namePlaceholder')} />
        </Field>

        <Switch label={t('flows.statusLabel')} description={t('flows.statusHint')} checked={draft.enabled} onChange={enabled => update({enabled})} />

        <fieldset className="lf-settings-group">
          <legend>{t('flows.when')}</legend>
          <RadioCards
            legend={<span className="visually-hidden">{t('flows.when')}</span>}
            name="flow-trigger"
            value={draft.kind}
            onChange={kind => update({kind, laneId: kind === draft.kind ? draft.laneId : ''})}
            columns={1}
            options={TRIGGER_KINDS.map(kind => ({value: kind, title: t(`flows.trigger.${kind}`), description: t(`flows.trigger.${kind}Hint`)}))}
          />
          <Field id={fieldId('trigger.laneId')} label={moveToLane ? t('flows.laneInto') : t('flows.laneIn')} error={message('trigger.laneId')}>
            <Select value={draft.laneId} onChange={e => update({laneId: e.target.value})} options={moveToLane ? laneOptions(draft.laneId) : anyLane(draft.laneId)} placeholder={t('flows.pickLane')} />
          </Field>
          {draft.kind === 'daily_due' && (
            <Field id={fieldId('trigger.dueInDays')} label={t('flows.dueInDays')} hint={t('flows.dueInDaysHint')} error={message('trigger.dueInDays')}>
              <input value={draft.dueInDays} onChange={e => update({dueInDays: e.target.value})} inputMode="numeric" autoComplete="off" maxLength={2} />
            </Field>
          )}
        </fieldset>

        <fieldset className="lf-settings-group">
          <legend>{t('flows.onlyIf')}</legend>
          <Field id={fieldId('conditions.labelId')} label={t('flows.hasLabel')} hint={context.labels.length === 0 ? t('flows.noLabels') : undefined} error={message('conditions.labelId')}>
            <Select value={draft.labelId} onChange={e => update({labelId: e.target.value})} options={noLabelPicked(draft.labelId)} />
          </Field>
        </fieldset>

        <fieldset className="lf-settings-group" aria-describedby={errors.actions && shown ? fieldId('actions') : undefined}>
          <legend>{t('flows.then')}</legend>
          <p className="lf-settings-sub">{t('flows.actionsHint', {max: MAX_ACTIONS})}</p>
          {message('actions') && (
            <p className="field-error" id={fieldId('actions')} role="alert" tabIndex={-1}>
              {message('actions')}
            </p>
          )}
          <ol className="lf-flow-actions">
            {draft.actions.map((action, index) => (
              <li key={action.key} className="lf-flow-action">
                <div className="lf-flow-action-head">
                  <span className="lf-flow-action-num">{t('flows.actionN', {n: index + 1})}</span>
                  <span className="lf-flow-action-tools">
                    <IconButton icon="chevron-up" size="sm" label={t('flows.moveUp', {n: index + 1})} disabled={index === 0 || pending} onClick={() => update({actions: moveAction(draft.actions, index, index - 1)})} />
                    <IconButton icon="chevron-down" size="sm" label={t('flows.moveDown', {n: index + 1})} disabled={index === draft.actions.length - 1 || pending} onClick={() => update({actions: moveAction(draft.actions, index, index + 1)})} />
                    <IconButton icon="trash" size="sm" label={t('flows.removeAction', {n: index + 1})} disabled={pending} onClick={() => update({actions: draft.actions.filter(a => a.key !== action.key)})} />
                  </span>
                </div>
                <Field id={`flow-actions-${index}-type`} label={t('flows.actionType')}>
                  <Select value={action.type} onChange={e => updateAction(action.key, {type: e.target.value as DraftAction['type']})} options={ACTION_TYPES.map(type => ({value: type, label: t(`flows.action.${type}`)}))} />
                </Field>
                <ActionFields action={action} index={index} context={context} message={message} onChange={patch => updateAction(action.key, patch)} personOptions={personOptions} laneOptions={laneOptions} labelOptions={labelOptions} />
              </li>
            ))}
          </ol>
          <div>
            <Button variant="secondary" icon="plus" disabled={pending || draft.actions.length >= MAX_ACTIONS} onClick={() => update({actions: [...draft.actions, newAction()]})}>
              {t('flows.addAction')}
            </Button>
          </div>
        </fieldset>

        {status && (
          <Notice tone="danger">{status}</Notice>
        )}
      </div>
    </Drawer>
  );
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}

function ActionFields({
  action,
  index,
  context,
  message,
  onChange,
  personOptions,
  laneOptions,
  labelOptions,
}: {
  action: DraftAction;
  index: number;
  context: FlowContext;
  message: (field: string) => string | undefined;
  onChange: (patch: Partial<DraftAction>) => void;
  personOptions: (value: string) => Option[];
  laneOptions: (value: string) => Option[];
  labelOptions: (value: string) => Option[];
}) {
  const t = useT();
  const at = (field: string) => `actions.${index}.${field}`;
  const person = (hint?: string) => (
    <Field id={fieldId(at('userId'))} label={t('flows.person')} hint={context.peopleLoading ? t('common.loading') : hint} error={message(at('userId'))}>
      <Select value={action.userId} onChange={e => onChange({userId: e.target.value})} options={personOptions(action.userId)} placeholder={t('flows.pickPerson')} />
    </Field>
  );
  switch (action.type) {
    case 'assign':
      return person();
    case 'add_label':
      return (
        <Field id={fieldId(at('labelId'))} label={t('flows.label')} hint={context.labels.length === 0 ? t('flows.noLabels') : undefined} error={message(at('labelId'))}>
          <Select value={action.labelId} onChange={e => onChange({labelId: e.target.value})} options={labelOptions(action.labelId)} placeholder={t('flows.pickLabel')} />
        </Field>
      );
    case 'move':
      return (
        <Field id={fieldId(at('laneId'))} label={t('flows.laneTo')} error={message(at('laneId'))}>
          <Select value={action.laneId} onChange={e => onChange({laneId: e.target.value})} options={laneOptions(action.laneId)} placeholder={t('flows.pickLane')} />
        </Field>
      );
    case 'comment':
      return (
        <Field id={fieldId(at('body'))} label={t('flows.commentText')} hint={t('flows.commentHint')} error={message(at('body'))}>
          <textarea value={action.body} onChange={e => onChange({body: e.target.value})} dir="auto" rows={3} maxLength={600} />
        </Field>
      );
    default:
      return (
        <>
          <RadioCards
            legend={t('flows.notifyWho')}
            name={`flow-notify-${action.key}`}
            value={action.target}
            onChange={target => onChange({target})}
            columns={1}
            options={[
              {value: 'assignees', title: t('flows.notify.assignees')},
              {value: 'user', title: t('flows.notify.user')},
            ]}
          />
          {action.target === 'user' && person()}
        </>
      );
  }
}
