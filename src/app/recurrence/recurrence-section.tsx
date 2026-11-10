import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {checkRule, FREQUENCIES, type Frequency} from '../../lib/recurrence';
import {Button, ErrorNote, Field, LoadingBlock, Select, useConfirm, useToast} from '../../portal/ui';
import {todayISO} from '../../portal/ui/date';
import {DatePicker} from '../../portal/ui/popover';
import {Section, useAction} from '../cards/parts';
import {useRecurrence, useRecurrenceActions, type RecurrenceT} from './api';
import './recurrence.css';

type Errors = Partial<Record<'frequency' | 'interval' | 'startOn' | 'endsOn', string>>;

/** "Repeat" in the card panel: a rule that makes a fresh copy of the card on a schedule (a background job does it). */
export function RecurrenceSection({cardId, canWrite, inbox = false, hideEmpty = false}: {cardId: number; canWrite: boolean; inbox?: boolean; hideEmpty?: boolean}) {
  const t = useT();
  const query = useRecurrence(cardId);
  const {save, stop} = useRecurrenceActions(cardId);
  const confirm = useConfirm();
  const {busy, run} = useAction();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  if (inbox) return null; // a personal inbox card cannot repeat
  const rule = query.data?.recurrence ?? null;
  const shown = rule?.enabled ? rule : null;
  // `hideEmpty`: nothing until a rule exists (the card panel sets one from its Dates popover).
  if (hideEmpty && !rule && !editing) return null;
  return (
    <Section id="cd-repeat" icon="refresh" title={t('rec.title')}>
      {query.isPending && <LoadingBlock />}
      {query.error && !query.data && <ErrorNote error={query.error} title={t('states.loadError')} />}
      {query.data && !editing && (
        <>
          <Summary rule={rule} />
          {canWrite && (
            <div className="rec-actions">
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={busy !== null}>
                {shown ? t('rec.edit') : t('rec.add')}
              </Button>
              {rule && (
                <Button
                  size="sm"
                  variant="danger"
                  pending={busy === 'stop'}
                  pendingLabel={t('rec.stopping')}
                  disabled={busy !== null}
                  onClick={() =>
                    void confirm({
                      title: t('rec.stopTitle'),
                      body: t('rec.stopBody'),
                      confirmLabel: t('rec.stop'),
                      action: async () => {
                        await stop();
                        toast.success(t('rec.stopped'));
                      },
                    })
                  }>
                  {t('rec.stop')}
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {query.data && editing && (
        <RuleForm
          rule={shown}
          pending={busy === 'save'}
          onCancel={() => setEditing(false)}
          onSave={async input => {
            const ok = await run('save', () => save(input));
            if (ok) {
              setEditing(false);
              toast.success(t('rec.saved'));
            }
          }}
        />
      )}
    </Section>
  );
}

function Summary({rule}: {rule: RecurrenceT | null}) {
  const t = useT();
  const {formatDate} = useI18n();
  const day = (iso: string) => formatDate(new Date(`${iso}T00:00:00Z`), {timeZone: 'UTC', dateStyle: 'medium'});
  if (!rule) return <p className="cd-none">{t('rec.none')}</p>;
  if (!rule.enabled) {
    return (
      <div className="rec-summary">
        <p>{t('rec.finished')}</p>
        {rule.lastRunOn && <p className="rec-meta">{t('rec.last', {date: day(rule.lastRunOn)})}</p>}
      </div>
    );
  }
  const every = rule.interval === 1 ? t(`rec.sum.${rule.frequency}1`) : t(`rec.sum.${rule.frequency}`, {n: rule.interval});
  return (
    <div className="rec-summary">
      <p>{every}</p>
      {rule.nextRunOn && <p className="rec-meta">{t('rec.next', {date: day(rule.nextRunOn)})}</p>}
      {rule.endsOn && <p className="rec-meta">{t('rec.until', {date: day(rule.endsOn)})}</p>}
      {rule.lastRunOn && <p className="rec-meta">{t('rec.last', {date: day(rule.lastRunOn)})}</p>}
      <p className="rec-meta">{t('rec.hint')}</p>
    </div>
  );
}

function RuleForm({rule, pending, onSave, onCancel}: {rule: RecurrenceT | null; pending: boolean; onSave: (v: {frequency: Frequency; interval: number; startOn: string; endsOn: string | null}) => Promise<void>; onCancel: () => void}) {
  const t = useT();
  const {locale, firstDayOfWeek} = useI18n();
  const [frequency, setFrequency] = useState<Frequency>(rule?.frequency ?? 'weekly');
  const [interval, setInterval] = useState(String(rule?.interval ?? 1));
  const [startOn, setStartOn] = useState(rule?.nextRunOn ?? todayISO());
  const [endsOn, setEndsOn] = useState(rule?.endsOn ?? '');
  const [errors, setErrors] = useState<Errors>({});

  // `only`: check one field (on blur, or live while typing once it shows an error) and leave the others as they are.
  const validate = (values: {frequency: Frequency; interval: string; startOn: string; endsOn: string} = {frequency, interval, startOn, endsOn}, only?: keyof Errors): boolean => {
    const n = /^\d{1,3}$/.test(values.interval.trim()) ? Number(values.interval.trim()) : NaN;
    const checked = checkRule({frequency: values.frequency, interval: n, startOn: values.startOn, endsOn: values.endsOn || null}, new Date().toISOString().slice(0, 10));
    if (only) {
      const why = checked.ok ? undefined : (checked.fields as Errors)[only];
      setErrors(prev => ({...prev, [only]: why === undefined ? undefined : message(only, why)}));
      return why === undefined;
    }
    if (checked.ok) {
      setErrors({});
      return true;
    }
    const next: Errors = {};
    for (const [name, why] of Object.entries(checked.fields) as [keyof Errors, string][]) next[name] = message(name, why);
    setErrors(next);
    // focus the first wrong field
    const first = (['frequency', 'interval', 'startOn', 'endsOn'] as const).find(name => next[name]);
    if (first) document.getElementById(`rec-${first === 'startOn' ? 'start' : first === 'endsOn' ? 'end' : first}`)?.focus();
    return false;
  };
  function message(name: keyof Errors, why: string): string {
    return name === 'interval' ? t('rec.errInterval') : name === 'startOn' ? (why === 'past' ? t('rec.errPast') : t('rec.errStart')) : name === 'endsOn' ? (why === 'before_start' ? t('rec.errEnd') : t('errors.invalid')) : t('errors.invalid');
  }
  const submit = () => {
    if (!validate()) return;
    void onSave({frequency, interval: Number(interval.trim()), startOn, endsOn: endsOn || null});
  };
  return (
    <form
      className="rec-form"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}>
      <div className="rec-row">
        <Field id="rec-frequency" label={t('rec.frequency')} error={errors.frequency}>
          <Select
            options={FREQUENCIES.map(f => ({value: f, label: t(`rec.freq.${f}`)}))}
            value={frequency}
            disabled={pending}
            onChange={event => setFrequency(event.target.value as Frequency)}
          />
        </Field>
        <Field id="rec-interval" label={t(`rec.every.${frequency}`)} error={errors.interval}>
          <input
            className="rec-interval"
            inputMode="numeric"
            autoComplete="off"
            maxLength={2}
            value={interval}
            disabled={pending}
            onChange={event => {
              const value = event.target.value;
              setInterval(value);
              if (errors.interval) validate({frequency, interval: value, startOn, endsOn}, 'interval');
            }}
            onBlur={() => validate(undefined, 'interval')}
          />
        </Field>
      </div>
      <div className="rec-row">
        <Field id="rec-start" label={t('rec.startOn')} error={errors.startOn}>
          <DatePicker id="rec-start" value={startOn} label={t('rec.startOn')} disabled={pending} locale={locale} firstDayOfWeek={firstDayOfWeek as 0} onChange={setStartOn} />
        </Field>
        <Field id="rec-end" label={t('rec.endsOn')} optional error={errors.endsOn}>
          <DatePicker id="rec-end" value={endsOn} label={t('rec.endsOn')} clearable disabled={pending} locale={locale} firstDayOfWeek={firstDayOfWeek as 0} placeholder={t('rec.endsNever')} onChange={setEndsOn} />
        </Field>
      </div>
      <div className="rec-actions">
        <Button type="submit" size="sm" pending={pending} pendingLabel={t('common.saving')}>
          {t('common.save')}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
