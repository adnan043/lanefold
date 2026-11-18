import {useEffect, useState} from 'react';

import type {ChatFileT} from '../../lib/chat-files';
import {useI18n, useT} from '../../i18n';
import {Button, buttonClass, Icon, Modal} from '../../portal/ui';
import {bytesLabel} from '../cards/parts';
import {chatFileUrl} from './api';

/**
 * The files sent with a message: pictures as small previews that open in a viewer, every other file as a row with its
 * size and a download link. Every link goes through the server, which checks access on each view.
 */
export function MessageFiles({files}: {files: readonly ChatFileT[]}) {
  const t = useT();
  const {formatNumber} = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  if (files.length === 0) return null;
  const images = files.filter(f => f.isImage);
  const others = files.filter(f => !f.isImage);
  return (
    <div className="chat-files-block">
      {images.length > 0 && (
        <ul className="chat-file-images" aria-label={t('chat.messageFiles')}>
          {images.map((f, i) => (
            <li key={f.id}>
              <button type="button" className="chat-file-image" aria-label={t('chat.openFile', {name: f.name})} onClick={() => setOpen(i)}>
                <img src={chatFileUrl(f.id)} alt={f.name} loading="lazy" decoding="async" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="chat-files" aria-label={t('chat.messageFiles')}>
          {others.map(f => (
            <li key={f.id} className="chat-file">
              <Icon name="file" size={16} />
              <a className="chat-file-name" href={chatFileUrl(f.id)} target="_blank" rel="noopener noreferrer" title={f.name}>
                {f.name}
              </a>
              <span className="chat-file-size muted">{bytesLabel(f.size, formatNumber)}</span>
              <a className="button button-ghost button-sm icon-button" href={chatFileUrl(f.id, true)} aria-label={t('chat.downloadFile', {name: f.name})} title={t('chat.downloadFile', {name: f.name})}>
                <Icon name="download" size={16} />
              </a>
            </li>
          ))}
        </ul>
      )}
      <ImageViewer images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </div>
  );
}

/**
 * A message's pictures, one at a time, in a rounded dialog: the arrow keys (and buttons) move between them, Esc or a
 * click outside closes, and focus goes back to the picture that opened it (the dialog's own behaviour).
 */
function ImageViewer({images, index, onIndex, onClose}: {images: readonly ChatFileT[]; index: number | null; onIndex: (i: number) => void; onClose: () => void}) {
  const t = useT();
  const current = index === null ? null : (images[index] ?? null);
  const many = images.length > 1;
  useEffect(() => {
    if (index === null || !many) return;
    const onKey = (event: KeyboardEvent) => {
      // Arrows follow the reading direction: in RTL, Left is "next".
      const rtl = document.documentElement.dir === 'rtl';
      if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) onIndex((index + 1) % images.length);
      else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, many, images.length, onIndex]);
  return (
    <Modal
      open={current !== null}
      onClose={onClose}
      size="lg"
      title={current?.name ?? ''}
      footer={
        <>
          {many && index !== null && (
            <span className="chat-viewer-nav">
              <Button variant="secondary" icon="arrow-left" aria-label={t('cd.previous')} onClick={() => onIndex((index - 1 + images.length) % images.length)} />
              <span className="chat-viewer-count muted" aria-live="polite">
                {index + 1} / {images.length}
              </span>
              <Button variant="secondary" icon="arrow-right" aria-label={t('cd.next')} onClick={() => onIndex((index + 1) % images.length)} />
            </span>
          )}
          {current && (
            <a className={buttonClass({variant: 'secondary'})} href={chatFileUrl(current.id, true)} rel="noopener noreferrer">
              <Icon name="download" size={16} /> {t('cd.download')}
            </a>
          )}
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      }>
      {current && (
        <div className="chat-viewer">
          <img key={current.id} src={chatFileUrl(current.id)} alt={current.name} decoding="async" />
        </div>
      )}
    </Modal>
  );
}
