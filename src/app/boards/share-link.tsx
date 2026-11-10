import {useEffect, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, Field, Notice, Select, useConfirm, useToast} from '../../portal/ui';
import {type ApiError, type BoardT, call} from '../api';

/**
 * "Public link" section of the board settings drawer: one read-only link for people outside the workspace.
 * Shown to board admins only (the server checks again). The full link comes back ONCE, from create / rotate, and is
 * kept only in this component's state: closing the drawer forgets it (the server keeps just a hash).
 */
export function ShareLink({board, open}: {board: BoardT; open: boolean}) {
  const t = useT();
  const {errorMessage, formatDate} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [active, setActive] = useState<boolean | null>(null);
  const [url, setUrl] = useState('');
  const [days, setDays] = useState('30'); // lifetime for the NEXT create / replace: '' = never
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const allowed = board.canAdmin && !board.archived && board.visibility !== 'private';

  useEffect(() => {
    setUrl('');
    setError('');
    if (!open || !allowed) return;
    let live = true;
    call<{active: boolean; expiresAt: string | null}>('GET', `/boards/${board.id}/share`)
      .then(res => {
        if (!live) return;
        setActive(res.active);
        setExpiresAt(res.expiresAt);
      })
      .catch(() => live && setActive(null));
    return () => {
      live = false;
    };
  }, [open, allowed, board.id]);

  if (!allowed) return null;

  const create = async () => {
    setBusy('create');
    setError('');
    try {
      const res = await call<{url: string; expiresAt: string | null}>('POST', `/boards/${board.id}/share`, {expiresInDays: days === '' ? null : Number(days)});
      setUrl(res.url);
      setExpiresAt(res.expiresAt);
      setActive(true);
    } catch (e) {
      setError(errorMessage(e as ApiError));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setBusy('revoke');
    setError('');
    try {
      await call('DELETE', `/boards/${board.id}/share`);
      setUrl('');
      setExpiresAt(null);
      setActive(false);
      toast.success(t('share.revoked'));
    } catch (e) {
      setError(errorMessage(e as ApiError));
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('share.copied'));
    } catch {
      field.current?.focus();
      field.current?.select();
    }
  };

  return (
    <fieldset className="lf-settings-group" aria-busy={busy !== null}>
      <legend>{t('share.title')}</legend>
      <p className="lf-settings-sub">{active ? t('share.activeHint') : t('share.offHint')}</p>
      {url && (
        <>
          <div className="field lf-share-link">
            <input ref={field} readOnly value={url} aria-label={t('share.linkLabel')} onFocus={event => event.currentTarget.select()} dir="ltr" />
          </div>
          <Notice tone="info">{t('share.once')}</Notice>
          <div className="lf-settings-actions">
            <Button variant="secondary" icon="copy" onClick={() => void copy()}>
              {t('share.copy')}
            </Button>
          </div>
        </>
      )}
      {active && <p className="lf-settings-sub">{expiresAt ? t('share.expiresOn', {date: formatDate(expiresAt)}) : t('share.neverExpires')}</p>}
      {!active && active !== null && expiresAt && <Notice tone="warning">{t('share.expiredNote')}</Notice>}
      <Field id="share-expiry" label={t('share.expiry')} hint={t('share.expiryHint')}>
        <Select
          id="share-expiry"
          value={days}
          disabled={busy !== null}
          onChange={event => setDays(event.target.value)}
          options={[
            {value: '7', label: t('share.expiry7')},
            {value: '30', label: t('share.expiry30')},
            {value: '90', label: t('share.expiry90')},
            {value: '', label: t('share.expiryNever')},
          ]}
        />
      </Field>
      <div className="lf-settings-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={busy !== null || active === null}
          pending={busy === 'create'}
          pendingLabel={t('share.creating')}
          onClick={() => void create()}>
          {active ? t('share.rotate') : t('share.create')}
        </Button>
        {active && (
          <Button
            type="button"
            variant="danger"
            disabled={busy !== null}
            pending={busy === 'revoke'}
            pendingLabel={t('share.revoking')}
            onClick={() =>
              void confirm({title: t('share.revokeTitle'), body: t('share.revokeBody'), confirmLabel: t('share.revoke'), action: revoke})
            }>
            {t('share.revoke')}
          </Button>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
