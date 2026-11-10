import {useQueryClient} from '@tanstack/react-query';
import {useEffect, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, Field, Modal, rules, useForm, useToast} from '../../portal/ui';
import {call} from '../api';

/** "Save as template" for one open card: asks for a name, the server reads the card itself. */
export function SaveTemplateDialog({open, cardId, defaultName, onClose}: {open: boolean; cardId: number; defaultName: string; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useForm({name: defaultName.slice(0, 80)}, {name: [rules.required(t('ctpl.nameRequired')), rules.maxLength(80, t('ctpl.nameTooLong'))]});
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!open) return;
    form.reset({name: defaultName.slice(0, 80)});
    setStatus('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = form.submit(async values => {
    setPending(true);
    setStatus('');
    try {
      await call('POST', `/cards/${cardId}/save-template`, {name: values.name.trim()});
      await queryClient.invalidateQueries({queryKey: ['card-templates']});
      toast.success(t('ctpl.saved'));
      onClose();
    } catch (error) {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error) as never);
      setStatus(errorMessage(error));
    } finally {
      setPending(false);
    }
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!pending}
      size="sm"
      title={t('ctpl.saveTitle')}
      description={t('ctpl.saveBody')}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="ctpl-save-form" pending={pending} pendingLabel={t('ctpl.saving')} disabled={form.blocked}>
            {t('ctpl.saveButton')}
          </Button>
        </>
      }>
      <form id="ctpl-save-form" noValidate onSubmit={submit}>
        <Field label={t('ctpl.nameLabel')} id="ctpl-name" error={form.error('name')}>
          <input className="input" {...form.field('name')} autoComplete="off" />
        </Field>
        <p role="status" className="form-status">
          {status}
        </p>
      </form>
    </Modal>
  );
}
