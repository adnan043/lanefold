import {useQueryClient} from '@tanstack/react-query';
import {useEffect, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, Checkbox, Field, Modal, Notice, rules, useForm, useToast} from '../../portal/ui';
import {ApiError, call} from '../api';
import './templates.css';

/**
 * "Save as template" for one open card: asks for a name, the server reads the card itself. Templates are seen by the
 * whole workspace, so a card on a private board (`privateBoard`, or the server's 409 when the board became private)
 * shows a warning and needs a ticked confirmation before it is saved.
 */
export function SaveTemplateDialog({open, cardId, defaultName, privateBoard = false, onClose}: {open: boolean; cardId: number; defaultName: string; privateBoard?: boolean; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useForm({name: defaultName.slice(0, 80)}, {name: [rules.required(t('ctpl.nameRequired')), rules.maxLength(80, t('ctpl.nameTooLong'))]});
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [serverPrivate, setServerPrivate] = useState(false);
  const [shareOk, setShareOk] = useState(false);
  const [shareError, setShareError] = useState('');
  const warn = privateBoard || serverPrivate;
  useEffect(() => {
    if (!open) return;
    form.reset({name: defaultName.slice(0, 80)});
    setStatus('');
    setServerPrivate(false);
    setShareOk(false);
    setShareError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = form.submit(async values => {
    if (warn && !shareOk) {
      setShareError(t('ctpl.privateConfirmRequired'));
      document.querySelector<HTMLInputElement>('#ctpl-share input')?.focus();
      return;
    }
    setPending(true);
    setStatus('');
    try {
      await call('POST', `/cards/${cardId}/save-template`, {name: values.name.trim(), ...(warn && shareOk ? {sharePrivate: true} : {})});
      await queryClient.invalidateQueries({queryKey: ['card-templates']});
      toast.success(t('ctpl.saved'));
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'template_private_board') setServerPrivate(true);
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
        {warn && (
          <div className="ctpl-private">
            <Notice tone="warning" title={t('ctpl.privateTitle')}>
              {t('ctpl.privateBody')}
            </Notice>
            <div id="ctpl-share">
              <Checkbox
                label={t('ctpl.privateConfirm')}
                checked={shareOk}
                disabled={pending}
                onChange={checked => {
                  setShareOk(checked);
                  if (checked) setShareError('');
                }}
              />
            </div>
            {shareError && (
              <p id="ctpl-share-error" className="field-error" role="alert">
                {shareError}
              </p>
            )}
          </div>
        )}
        <p role="status" className="form-status">
          {status}
        </p>
      </form>
    </Modal>
  );
}
