import {useMutation, useQueryClient} from '@tanstack/react-query';
import {useEffect, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Button, Checkbox, Field, Icon, Modal, Notice, SegmentedControl, Select, useForm} from '../../portal/ui';
import {call} from '../api';
import {type EmailPreview, type EmailStatus} from './invite-text';

type Kind = 'link' | 'invite';
type Created = {kind: Kind; url: string; role: string; emailStatus: EmailStatus | null; preview: EmailPreview | null};
type CreateResponse = {token: string; emailStatus?: EmailStatus | null; emailPreview?: EmailPreview};

const DAYS = [1, 7, 14, 30];
const ROLES = ['viewer', 'member', 'admin'] as const;

/** Copies text; falls back to selecting the field when the clipboard is blocked. */
async function copyText(text: string, field: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    field?.focus();
    field?.select();
    return false;
  }
}

/**
 * Join link (many people, a use limit) or single-use invite (optionally for one address). The token comes back ONCE:
 * it is shown here with a copy button and is gone when the dialog closes (the server keeps only its hash).
 */
export function InviteModal({workspaceId, open, onClose}: {workspaceId: number; open: boolean; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<Kind>('link');
  const [role, setRole] = useState<string>('member');
  const [days, setDays] = useState('7');
  const [status, setStatus] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  // null = follow the default (on once an address is typed); true / false = the admin chose.
  const [emailChoice, setEmailChoice] = useState<boolean | null>(null);
  const urlField = useRef<HTMLInputElement>(null);
  const form = useForm({maxUses: '10', email: ''}, {
    maxUses: kind === 'link' ? [rules.required(t('members.maxUsesRequired')), rules.wholeNumber(t('members.maxUsesRange')), v => (Number(v) >= 1 && Number(v) <= 100 ? null : t('members.maxUsesRange'))] : [],
    email: kind === 'invite' ? [rules.email(t('members.emailInvalid'))] : [],
  });

  const hasEmail = kind === 'invite' && form.values.email.trim() !== '';
  const sendEmail = hasEmail && (emailChoice ?? true);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const create = useMutation({
    mutationFn: async () => {
      const body = kind === 'link' ? {role, expiresInDays: Number(days), maxUses: Number(form.values.maxUses)} : {role, expiresInDays: Number(days), ...(form.values.email.trim() ? {email: form.values.email.trim(), sendEmail} : {})};
      const res = await call<CreateResponse>('POST', `/workspaces/${workspaceId}/${kind === 'link' ? 'join-links' : 'invites'}`, body);
      return res;
    },
    onSuccess: res => {
      setCreated({kind, role, url: `${window.location.origin}/app/join/${res.token}`, emailStatus: res.emailStatus ?? null, preview: res.emailPreview ?? null});
      void queryClient.invalidateQueries({queryKey: [kind === 'link' ? 'join-links' : 'invites', workspaceId]});
    },
    onError: error => {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error));
      setStatus(errorMessage(error));
    },
  });

  const close = () => {
    if (create.isPending) return;
    form.reset();
    setCreated(null);
    setEmailChoice(null);
    setStatus('');
    setCopied(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!create.isPending}
      title={created ? t('members.linkReadyTitle') : t('members.inviteTitle')}
      description={created ? undefined : t('members.inviteDescription')}
      footer={
        created ? (
          <Button onClick={close}>{t('members.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" disabled={create.isPending} onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="invite-form" pending={create.isPending} pendingLabel={t('common.creating')} disabled={form.blocked}>
              {kind === 'link' ? t('members.createLink') : t('members.createInvite')}
            </Button>
          </>
        )
      }>
      {created ? (
        <div className="lf-form">
          <Notice tone="warning">{t('members.shownOnce')}</Notice>
          <Field id="invite-url" label={created.kind === 'link' ? t('members.joinLink') : t('members.inviteLink')}>
            <input id="invite-url" ref={urlField} readOnly value={created.url} onFocus={event => event.currentTarget.select()} />
          </Field>
          <div className="lf-form-actions">
            <Button
              variant="secondary"
              icon={copied ? 'check' : 'copy'}
              onClick={async () => {
                const ok = await copyText(created.url, urlField.current);
                setCopied(ok);
                if (!ok) setStatus(t('members.copyFailed'));
              }}>
              {copied ? t('members.copied') : t('members.copy')}
            </Button>
          </div>
          {created.emailStatus === 'queued' && <Notice tone="success">{t('invite.emailQueued')}</Notice>}
          {created.emailStatus === 'failed' && <Notice tone="danger">{t('invite.emailFailed')}</Notice>}
          {created.emailStatus === 'not_configured' && <Notice tone="warning">{t('invite.emailNotSetUp')}</Notice>}
          {created.preview && (
            <section aria-labelledby="invite-email-preview" className="lf-form">
              <h3 id="invite-email-preview">{created.preview.configured ? t('invite.emailPreviewTitleTest') : t('invite.emailPreviewTitle')}</h3>
              <Field id="invite-preview-subject" label={t('invite.emailPreviewSubject')}>
                <input id="invite-preview-subject" readOnly value={created.preview.subject} />
              </Field>
              <Field id="invite-preview-body" label={t('invite.emailPreviewBody')}>
                <textarea id="invite-preview-body" readOnly rows={10} value={created.preview.text} />
              </Field>
            </section>
          )}
          <p className="muted" aria-live="polite">
            {status}
          </p>
        </div>
      ) : (
        <form
          id="invite-form"
          className="lf-form"
          noValidate
          onSubmit={form.submit(() => {
            setStatus('');
            create.mutate();
          })}>
          <SegmentedControl<Kind>
            label={t('members.kind')}
            value={kind}
            onChange={next => {
              setKind(next);
              setStatus('');
            }}
            options={[
              {value: 'link', label: t('members.kind.link')},
              {value: 'invite', label: t('members.kind.invite')},
            ]}
          />
          <p className="muted">{kind === 'link' ? t('members.kind.linkHint') : t('members.kind.inviteHint')}</p>
          <Field id="invite-role" label={t('members.role')}>
            <Select id="invite-role" value={role} onChange={event => setRole(event.target.value)} options={ROLES.map(r => ({value: r, label: t(`members.role.${r}`)}))} />
          </Field>
          <Field id="invite-days" label={t('members.expires')}>
            <Select id="invite-days" value={days} onChange={event => setDays(event.target.value)} options={DAYS.map(d => ({value: String(d), label: t('members.days', {n: d})}))} />
          </Field>
          {kind === 'link' ? (
            <Field id="f-maxUses" label={t('members.maxUses')} hint={t('members.maxUsesHint')} error={form.error('maxUses')}>
              <input inputMode="numeric" autoComplete="off" placeholder="10" {...form.field('maxUses')} />
            </Field>
          ) : (
            <>
              <Field id="f-email" label={t('members.inviteEmail')} hint={t('members.inviteEmailHint')} error={form.error('email')}>
                <input type="email" autoComplete="off" placeholder={t('members.emailPlaceholder')} {...form.field('email')} />
              </Field>
              {hasEmail && <Checkbox label={t('invite.emailAlso')} description={t('invite.emailAlsoHint')} checked={sendEmail} onChange={setEmailChoice} disabled={create.isPending} />}
            </>
          )}
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
