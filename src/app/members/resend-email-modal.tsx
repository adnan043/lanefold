import {useMutation, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Button, Field, Icon, Modal, Notice, useForm, useToast} from '../../portal/ui';
import {call} from '../api';
import {type EmailPreview, type EmailStatus} from './invite-text';

type Resent = {token: string; emailStatus: EmailStatus; emailPreview?: EmailPreview};

/**
 * "Resend email" for a failed invite. The server never keeps the address, so the admin types it again; it is checked
 * against the invite and sent only to the mail job. The old link stops working: the new one is shown here.
 */
export function ResendEmailModal({workspaceId, inviteId, onClose}: {workspaceId: number; inviteId: number | null; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<Resent | null>(null);
  const form = useForm({email: ''}, {email: [rules.required(t('members.emailInvalid')), rules.email(t('members.emailInvalid'))]});

  const resend = useMutation({
    mutationFn: () => call<Resent>('POST', `/workspaces/${workspaceId}/invites/${inviteId}/email`, {email: form.values.email.trim()}),
    onSuccess: res => {
      setResult(res);
      if (res.emailStatus === 'queued') toast.success(t('invite.resendQueued'));
      else if (res.emailStatus === 'failed') toast.danger(t('invite.resendFailed'));
      void queryClient.invalidateQueries({queryKey: ['invites', workspaceId]});
    },
    onError: error => {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error));
      setStatus(errorMessage(error));
    },
  });

  const close = () => {
    if (resend.isPending) return;
    form.reset();
    setResult(null);
    setStatus('');
    onClose();
  };
  const link = result ? `${window.location.origin}/app/join/${result.token}` : '';

  return (
    <Modal
      open={inviteId !== null}
      onClose={close}
      dismissible={!resend.isPending}
      title={t('invite.resendTitle')}
      description={result ? undefined : t('invite.resendDescription')}
      footer={
        result ? (
          <Button onClick={close}>{t('members.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" disabled={resend.isPending} onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="resend-form" pending={resend.isPending} pendingLabel={t('invite.resending')} disabled={form.blocked}>
              {t('invite.resend')}
            </Button>
          </>
        )
      }>
      {result ? (
        <div className="lf-form">
          {result.emailStatus === 'not_configured' && <Notice tone="warning">{t('invite.resendNotSent')}</Notice>}
          <Field id="resend-url" label={t('invite.resendLinkTitle')}>
            <input id="resend-url" readOnly value={link} onFocus={event => event.currentTarget.select()} />
          </Field>
          {result.emailPreview && (
            <Field id="resend-preview" label={result.emailPreview.configured ? t('invite.emailPreviewTitleTest') : t('invite.emailPreviewTitle')}>
              <textarea id="resend-preview" readOnly rows={10} value={`${result.emailPreview.subject}\n\n${result.emailPreview.text}`} />
            </Field>
          )}
        </div>
      ) : (
        <form
          id="resend-form"
          className="lf-form"
          noValidate
          onSubmit={form.submit(() => {
            setStatus('');
            resend.mutate();
          })}>
          <Field id="f-email" label={t('invite.resendEmail')} error={form.error('email')}>
            <input type="email" autoComplete="off" placeholder={t('members.emailPlaceholder')} {...form.field('email')} />
          </Field>
          {status && (
            <p className="field-error" role="alert">
              <Icon name="alert" size={14} /> {status}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
