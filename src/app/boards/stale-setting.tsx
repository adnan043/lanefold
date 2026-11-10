import {useEffect, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {STALE_DAY_OPTIONS} from '../../lib/stale';
import {Field, Select, useToast} from '../../portal/ui';
import {type ApiError, type BoardT, call} from '../api';

/**
 * "Stale cards" section of the board settings drawer: remind the people on a card (and its followers) when it has sat
 * in the same lane for 3, 7, 14 or 30 days. Off by default. Board admins only (the server checks again). Saves as soon
 * as the choice changes; the select is disabled while the save runs, and a failure puts the old choice back.
 */
export function StaleSetting({board, open}: {board: BoardT; open: boolean}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null); // '' = off; null = not loaded yet
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allowed = board.canAdmin && !board.archived;

  useEffect(() => {
    setError('');
    if (!open || !allowed) return;
    let live = true;
    call<{staleDays: number | null}>('GET', `/boards/${board.id}/stale-days`)
      .then(res => live && setValue(res.staleDays === null ? '' : String(res.staleDays)))
      .catch(() => live && setValue(null));
    return () => {
      live = false;
    };
  }, [open, allowed, board.id]);

  if (!allowed) return null;

  const change = async (next: string) => {
    const before = value;
    setBusy(true);
    setError('');
    setValue(next);
    try {
      await call('PUT', `/boards/${board.id}/stale-days`, {staleDays: next === '' ? null : Number(next)});
      toast.success(t('stale.saved'));
    } catch (e) {
      setValue(before);
      setError(errorMessage(e as ApiError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="lf-settings-group" aria-busy={busy}>
      <legend>{t('stale.title')}</legend>
      <p className="lf-settings-sub">{t('stale.hint')}</p>
      <Field id="stale-days" label={t('stale.label')} error={error || undefined}>
        <Select
          id="stale-days"
          value={value ?? ''}
          disabled={busy || value === null}
          onChange={event => void change(event.target.value)}
          options={[{value: '', label: t('stale.off')}, ...STALE_DAY_OPTIONS.map(days => ({value: String(days), label: String(days)}))]}
        />
      </Field>
    </fieldset>
  );
}
