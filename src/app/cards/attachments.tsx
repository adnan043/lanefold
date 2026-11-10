import {type RefObject, useEffect, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Button, buttonClass, Field, Icon, type IconName, Menu, type MenuItem, Modal, Notice, useConfirm, useForm, useToast} from '../../portal/ui';
import {ApiError} from '../api';
import {bytesLabel, useAction} from './parts';
import type {AttachmentT, CardActions, DetailT} from './use-card';

const MAX_BYTES = 100 * 1024 * 1024;
const viewUrl = (a: AttachmentT, download = false) => `/site-api/attachments/${a.id}/view${download ? '?download=1' : ''}`;
const openAway = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

const iconFor = (a: AttachmentT): IconName => (!a.isFile ? 'link' : a.isImage ? 'image' : 'file');

type Upload = {key: number; name: string; failed: string | null};
let uploadKey = 0;

function LinkDialog({open, actions, onClose}: {open: boolean; actions: CardActions; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const form = useForm(
    {url: '', name: ''},
    {
      url: [rules.required(t('cd.linkInvalid')), value => (/^https?:\/\/\S+$/i.test(value.trim()) ? null : t('cd.linkInvalid'))],
      name: [rules.maxLength(200, t('cd.textTooLong', {max: 200}))],
    }
  );
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (open) {
      form.reset({url: '', name: ''});
      setStatus('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = async () => {
    setPending(true);
    setStatus('');
    try {
      await actions.addLink(form.values.url.trim(), form.values.name.trim());
      onClose();
    } catch (error) {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error) as never);
      setStatus(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!pending}
      title={t('cd.attachLink')}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="link-form" pending={pending} pendingLabel={t('common.saving')} disabled={form.blocked}>
            {t('cd.linkAdd')}
          </Button>
        </>
      }>
      <form id="link-form" className="lf-form" noValidate onSubmit={form.submit(() => void save())}>
        <Field id="link-url" label={t('cd.linkUrl')} error={form.error('url')}>
          <input {...form.field('url')} type="url" inputMode="url" autoComplete="off" placeholder="https://example.com/page" />
        </Field>
        <Field id="link-name" label={t('cd.linkName')} optional error={form.error('name')}>
          <input {...form.field('name')} autoComplete="off" maxLength={200} placeholder={t('cd.linkName')} />
        </Field>
        {status && (
          <p className="field-error" role="alert">
            {status}
          </p>
        )}
      </form>
    </Modal>
  );
}

function RenameDialog({target, actions, onClose}: {target: AttachmentT | null; actions: CardActions; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const form = useForm({name: target?.name ?? ''}, {name: [rules.required(t('cd.textRequired')), rules.maxLength(200, t('cd.textTooLong', {max: 200}))]});
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (target) {
      form.reset({name: target.name});
      setStatus('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);
  const save = async () => {
    if (!target) return;
    setPending(true);
    try {
      await actions.renameAttachment(target.id, form.values.name.trim());
      onClose();
    } catch (error) {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error) as never);
      setStatus(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      dismissible={!pending}
      title={t('cd.rename')}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="rename-form" pending={pending} pendingLabel={t('common.saving')} disabled={form.blocked}>
            {t('common.save')}
          </Button>
        </>
      }>
      <form id="rename-form" className="lf-form" noValidate onSubmit={form.submit(() => void save())}>
        <Field id="rename-name" label={t('cd.attachmentName')} error={form.error('name')}>
          <input {...form.field('name')} autoComplete="off" maxLength={400} placeholder={t('cd.attachmentName')} />
        </Field>
        {status && (
          <p className="field-error" role="alert">
            {status}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** Image preview: Left / Right arrows move between the card's images, Esc closes. */
function Lightbox({images, index, onIndex, onClose}: {images: AttachmentT[]; index: number | null; onIndex: (i: number) => void; onClose: () => void}) {
  const t = useT();
  const current = index === null ? null : images[index];
  useEffect(() => {
    if (index === null) return;
    const onKey = (event: KeyboardEvent) => {
      // Arrows follow the reading direction: in RTL, Left is "next".
      const rtl = document.documentElement.dir === 'rtl';
      if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) onIndex((index + 1) % images.length);
      else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onIndex]);
  return (
    <Modal
      open={current != null}
      onClose={onClose}
      size="lg"
      title={current?.name ?? ''}
      footer={
        <>
          {images.length > 1 && index !== null && (
            <>
              <Button variant="secondary" icon="arrow-left" aria-label={t('cd.previous')} onClick={() => onIndex((index - 1 + images.length) % images.length)} />
              <Button variant="secondary" icon="arrow-right" aria-label={t('cd.next')} onClick={() => onIndex((index + 1) % images.length)} />
            </>
          )}
          {current && (
            <a className={buttonClass({variant: 'secondary'})} href={viewUrl(current, true)} rel="noopener noreferrer">
              {t('cd.download')}
            </a>
          )}
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      }>
      {current && <img className="cd-lightbox" src={viewUrl(current)} alt={current.name} decoding="async" />}
    </Modal>
  );
}

export function Attachments({detail, actions, intake}: {detail: DetailT; actions: CardActions; intake: RefObject<((files: File[]) => void) | null>}) {
  const t = useT();
  const {errorMessage, formatNumber} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const {busy, run} = useAction();
  const {canWrite, canAdmin, attachments} = detail;
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [renaming, setRenaming] = useState<AttachmentT | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const images = attachments.filter(a => a.isFile && a.isImage && !a.url);

  const addFiles = (files: File[]) => {
    if (!canWrite) return;
    void (async () => {
      for (const file of files) {
        if (file.size > MAX_BYTES) {
          toast.danger(t('cd.fileTooBig', {name: file.name, max: '100 MB'}));
          continue;
        }
        const key = ++uploadKey;
        setUploads(list => [...list, {key, name: file.name, failed: null}]);
        try {
          await actions.upload(file);
          setUploads(list => list.filter(u => u.key !== key));
        } catch (error) {
          const code = error instanceof ApiError ? error.code : undefined;
          const message = errorMessage(error);
          // The owner has to act on these: keep the words on screen until dismissed, not in a toast.
          if (code?.startsWith('E_STORAGE') || code === 'storage_quota') setNotice(message);
          else toast.danger(`${file.name}: ${message}`);
          setUploads(list => list.filter(u => u.key !== key));
        }
      }
    })();
  };
  useEffect(() => {
    intake.current = addFiles;
    return () => {
      intake.current = null;
    };
  });

  const menu = (a: AttachmentT): MenuItem[] => {
    const items: MenuItem[] = [{label: t('cd.open'), icon: 'external', onSelect: () => openAway(a.url ?? viewUrl(a))}];
    if (a.isFile) items.push({label: t('cd.download'), icon: 'download', onSelect: () => openAway(viewUrl(a, true))});
    if (canWrite && a.isFile && a.isImage) {
      items.push({
        label: a.isCover ? t('cd.coverRemove') : t('cd.coverMake'),
        icon: 'image',
        onSelect: () => void run(`a-${a.id}`, () => actions.setCover(a.isCover ? null : a.id)),
      });
    }
    if (canWrite) items.push({label: t('cd.rename'), icon: 'pencil', onSelect: () => setRenaming(a)});
    if (canWrite && (a.mine || canAdmin)) {
      items.push('separator', {
        label: t('cd.remove'),
        icon: 'trash',
        danger: true,
        onSelect: () =>
          void confirm({title: t('cd.removeTitle', {name: a.name}), body: t('cd.removeBody'), confirmLabel: t('cd.remove'), action: () => actions.removeAttachment(a.id)}),
      });
    }
    return items;
  };

  return (
    <section className="cd-feed" id="cd-attachments" aria-label={t('cd.attachments')}>
      {canWrite && (
        <>
          {/* No heading or buttons on screen: the editor's paperclip and "+" menu press these (drop and paste work too). */}
          <button type="button" id="cd-attachments-link" hidden tabIndex={-1} onClick={() => setLinking(true)} />
          <button type="button" id="cd-attachments-add" hidden tabIndex={-1} onClick={() => picker.current?.click()} />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={event => {
              addFiles([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </>
      )}
      {notice && (
        <Notice tone="warning" action={<Button size="sm" variant="secondary" onClick={() => setNotice(null)}>{t('common.close')}</Button>}>
          {notice}
        </Notice>
      )}
      {uploads.length > 0 && (
        <ul className="cd-uploads" role="status">
          {uploads.map(u => (
            <li key={u.key}>
              <span className="spinner" aria-hidden="true" /> {t('cd.uploading', {name: u.name})}
            </li>
          ))}
        </ul>
      )}
      {attachments.length === 0 && uploads.length === 0 ? (
        <p className="cd-none">{canWrite ? t('cd.dropHint') : t('cd.attachmentsNone')}</p>
      ) : (
        <ul className="cd-attachments">
          {attachments.map(a => {
            const imageIndex = images.findIndex(i => i.id === a.id);
            const body = (
              <>
                {a.isFile && a.isImage ? (
                  <img className="cd-thumb" src={viewUrl(a)} alt={a.name} loading="lazy" decoding="async" />
                ) : (
                  <span className="cd-thumb cd-thumb-icon">
                    <Icon name={iconFor(a)} size={22} />
                  </span>
                )}
                <span className="cd-attachment-text" hidden={imageIndex >= 0 || undefined}>
                  <span className="cd-attachment-name">{a.name}</span>
                  <span className="cd-none">
                    {a.isFile ? bytesLabel(a.size, formatNumber) : (a.url ?? '').replace(/^https?:\/\//, '').slice(0, 60)}
                    {a.isCover ? ` · ${t('cd.cover')}` : ''}
                  </span>
                </span>
              </>
            );
            return (
              <li key={a.id} className="cd-attachment" data-image={imageIndex >= 0 ? '' : undefined} aria-busy={busy === `a-${a.id}` || undefined}>
                {imageIndex >= 0 ? (
                  <button type="button" className="cd-attachment-open" onClick={() => setLightbox(imageIndex)}>
                    {body}
                  </button>
                ) : (
                  <a className="cd-attachment-open" href={a.url ?? viewUrl(a)} target="_blank" rel="noopener noreferrer">
                    {body}
                  </a>
                )}
                <Menu label={t('cd.attachmentMenu', {name: a.name})} items={menu(a)} />
              </li>
            );
          })}
        </ul>
      )}
      <LinkDialog open={linking} actions={actions} onClose={() => setLinking(false)} />
      <RenameDialog target={renaming} actions={actions} onClose={() => setRenaming(null)} />
      <Lightbox images={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
    </section>
  );
}
