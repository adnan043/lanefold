import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';

import {useT} from '../../i18n';
import {Card, Field, LoadingBlock, Notice, PageHeader, Select, useToast} from '../../portal/ui';
import {type ApiError, call} from '../api';
import {SettingsNav} from './nav';

type Mode = 'off' | 'digest' | 'immediate';
type State = {mode: Mode; available: boolean};
const key = ['notification-email'];

type Digest = {hour: number | null; timezone: string | null; mailConfigured: boolean; emailOn: boolean};
const digestKey = ['morning-digest'];
/** The local hours a morning digest can be made at (the server's CHECK is the same range). */
const DIGEST_HOURS = [5, 6, 7, 8, 9, 10, 11, 12];
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

/** The morning digest: one summary a day (due today, overdue, unread mentions) in the bell, and by email when notification emails are on. Off unless chosen. */
function DigestCard() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({queryKey: digestKey, queryFn: () => call<Digest>('GET', '/morning-digest'), staleTime: 60_000});
  const save = useMutation({
    mutationFn: (hour: number | null) => call<Digest>('PATCH', '/morning-digest', {hour, timezone: browserZone()}),
    onSuccess: saved => {
      queryClient.setQueryData(digestKey, saved);
      toast.success(t('settings.saved'));
    },
    onError: () => undefined, // shown next to the field below
  });
  const data = query.data;
  const value = save.isPending ? save.variables ?? null : data?.hour ?? null;
  return (
    <Card>
      {query.isPending ? (
        <LoadingBlock rows={2} />
      ) : query.error || !data ? (
        <Notice tone="danger">{query.error ? (query.error as ApiError).message : t('errors.unknown')}</Notice>
      ) : (
        <div className="lf-form">
          <h3>{t('digest.title')}</h3>
          <p className="muted">{t('digest.description')}</p>
          <Field id="f-digest-hour" label={t('digest.label')} hint={t('digest.hint')}>
            <Select
              id="f-digest-hour"
              value={value === null ? 'off' : String(value)}
              disabled={save.isPending}
              aria-busy={save.isPending}
              options={[{value: 'off', label: t('digest.off')}, ...DIGEST_HOURS.map(h => ({value: String(h), label: hourLabel(h)}))]}
              onChange={event => {
                const next = event.target.value;
                save.mutate(next === 'off' ? null : Number(next));
              }}
            />
          </Field>
          {value !== null && !data.emailOn && <p className="muted">{t('digest.emailOff')}</p>}
          {value !== null && data.emailOn && !data.mailConfigured && <Notice tone="warning">{t('notifEmail.unavailable')}</Notice>}
          {save.isPending && (
            <p className="muted" role="status">
              {t('notifEmail.saving')}
            </p>
          )}
          {save.isError && !save.isPending && (
            <div role="alert">
              <Notice tone="danger">{(save.error as ApiError).message || t('errors.unknown')}</Notice>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** `/app/settings/notifications`: email me about @mentions and assignments. Off by default; the choice is this person's alone. */
export function NotificationSettings() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({queryKey: key, queryFn: () => call<State>('GET', '/notification-email'), staleTime: 60_000});
  const save = useMutation({
    mutationFn: (mode: Mode) => call<State>('PATCH', '/notification-email', {mode}),
    onSuccess: saved => {
      queryClient.setQueryData(key, saved);
      toast.success(t('settings.saved'));
    },
    onError: () => undefined, // shown next to the field below
  });
  const data = query.data;
  return (
    <div className="app-page">
      <SettingsNav />
      <PageHeader title={t('notifEmail.title')} description={t('notifEmail.description')} />
      <Card>
        {query.isPending ? (
          <LoadingBlock rows={2} />
        ) : query.error || !data ? (
          <Notice tone="danger">{query.error ? (query.error as ApiError).message : t('errors.unknown')}</Notice>
        ) : (
          <div className="lf-form">
            {!data.available && <Notice tone="warning">{t('notifEmail.unavailable')}</Notice>}
            <Field id="f-notif-email" label={t('notifEmail.label')} hint={t('notifEmail.hint')}>
              <Select
                id="f-notif-email"
                value={save.isPending ? (save.variables ?? data.mode) : data.mode}
                disabled={save.isPending}
                aria-busy={save.isPending}
                options={[
                  {value: 'off', label: t('notifEmail.off')},
                  {value: 'digest', label: t('notifEmail.digest')},
                  {value: 'immediate', label: t('notifEmail.immediate')},
                ]}
                onChange={event => {
                  const next = event.target.value as Mode;
                  if (next === 'off' || next === 'digest' || next === 'immediate') save.mutate(next);
                }}
              />
            </Field>
            {save.isPending && (
              <p className="muted" role="status">
                {t('notifEmail.saving')}
              </p>
            )}
            {save.isError && !save.isPending && (
              <div role="alert">
                <Notice tone="danger">{(save.error as ApiError).message || t('errors.unknown')}</Notice>
              </div>
            )}
          </div>
        )}
      </Card>
      <DigestCard />
    </div>
  );
}
