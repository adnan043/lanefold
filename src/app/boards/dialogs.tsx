import {useEffect, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Button, Field, Modal, useForm} from '../../portal/ui';
import {ColorPicker} from '../../portal/ui/popover';
import type {ApiError, LaneT} from '../api';
import {useDraft} from '../use-draft';
import type {BoardActions} from './actions';

/** Shared bits of an edit dialog: server errors on their fields, the rest in a status line, never stuck pending. */
function useSave<V extends Record<string, string | boolean>>(
  form: ReturnType<typeof useForm<V>>,
  save: () => Promise<void>,
  onDone: () => void
) {
  const {fieldErrors, errorMessage} = useI18n();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const run = async () => {
    setPending(true);
    setStatus('');
    try {
      await save();
      onDone();
    } catch (error) {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error) as never);
      setStatus(errorMessage(error as ApiError));
    } finally {
      setPending(false);
    }
  };
  return {pending, status, run, setStatus};
}

export function EditLaneDialog({lane, actions, onClose}: {lane: LaneT | null; actions: BoardActions; onClose: () => void}) {
  const t = useT();
  const form = useForm(
    {name: lane?.name ?? '', wip: lane?.wipLimit ? String(lane.wipLimit) : ''},
    {
      name: [rules.required(t('lane.nameRequired')), rules.maxLength(80, t('lane.nameTooLong'))],
      wip: [
        rules.wholeNumber(t('lane.wipInvalid')),
        value => (!value.trim() || (Number(value) >= 1 && Number(value) <= 999) ? null : t('lane.wipInvalid')),
      ],
    }
  );
  const [color, setColor] = useState('');
  useEffect(() => {
    if (!lane) return;
    form.reset({name: lane.name, wip: lane.wipLimit ? String(lane.wipLimit) : ''});
    setColor(lane.colorHex ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane?.id]);
  // The name is kept across a forced sign-in; switched on only once the form holds this lane's values.
  const [syncedId, setSyncedId] = useState<number | null>(null);
  useEffect(() => setSyncedId(lane?.id ?? null), [lane?.id]);
  const clearDraft = useDraft('lane', lane?.id ?? 0, form.values.name, text => form.set('name', text), lane?.name ?? '', lane !== null && syncedId === lane.id);
  const close = () => {
    clearDraft();
    onClose();
  };
  const saving = useSave(
    form,
    async () => {
      if (!lane) return;
      await actions.updateLane(lane.id, {
        name: form.values.name.trim(),
        colorHex: color || null,
        wipLimit: form.values.wip.trim() ? Number(form.values.wip) : null,
      });
    },
    close
  );
  return (
    <Modal
      open={lane !== null}
      onClose={close}
      dismissible={!saving.pending}
      title={t('lane.edit')}
      footer={
        <>
          <Button variant="secondary" disabled={saving.pending} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="edit-lane-form" pending={saving.pending} pendingLabel={t('common.saving')} disabled={form.blocked}>
            {t('common.save')}
          </Button>
        </>
      }>
      <form id="edit-lane-form" className="lf-form" noValidate onSubmit={form.submit(() => void saving.run())}>
        <Field id="f-name" label={t('lane.name')} error={form.error('name')}>
          <input {...form.field('name')} dir="auto" autoComplete="off" maxLength={200} placeholder={t('lane.namePlaceholder')} />
        </Field>
        <Field id="f-color" label={t('lane.color')} optional>
          <ColorPicker id="f-color" value={color} onChange={setColor} label={t('lane.color')} />
        </Field>
        <Field id="f-wip" label={t('lane.wip')} hint={t('lane.wipHint')} error={form.error('wip')} optional>
          <input {...form.field('wip')} inputMode="numeric" autoComplete="off" placeholder="5" />
        </Field>
        {saving.status && (
          <p className="field-error" role="alert">
            {saving.status}
          </p>
        )}
      </form>
    </Modal>
  );
}
