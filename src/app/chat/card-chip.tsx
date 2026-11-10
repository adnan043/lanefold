import {useQuery} from '@tanstack/react-query';
import {Link} from '../nav';

import {useT} from '../../i18n';
import {Icon} from '../../portal/ui';
import {cardRefsQuery, type CardRefT} from './api';

/**
 * A card a message points at. The server sends ids only; titles come from ONE batched read of the cards the
 * viewer may see, so a private board's title never travels in the message. Absent (no access) or still loading:
 * a plain "Card" chip that is not a link.
 */
export function CardChip({data, pending}: {data?: CardRefT; pending: boolean}) {
  const t = useT();
  if (!data) {
    return (
      <span className="chat-card-ref" data-state={pending ? 'loading' : 'none'} aria-busy={pending || undefined} title={pending ? undefined : t('chat.cardUnavailable')}>
        <Icon name="checklist" size={14} /> {t('chat.cardChip')}
      </span>
    );
  }
  return (
    <Link to={`/b/${data.boardId}/c/${data.id}` as never} className="chat-card-ref" aria-label={t('chat.openCard', {title: data.title})}>
      <Icon name="checklist" size={14} />
      <span className="chat-card-chip-title" title={data.title}>{data.number != null ? `#${data.number} ` : ''}{data.title}</span>
    </Link>
  );
}

/** The chips under a message body: one query for all its cards (key = sorted ids). */
export function CardChips({cardIds}: {cardIds: readonly number[]}) {
  const t = useT();
  const {data, isPending} = useQuery(cardRefsQuery(cardIds));
  if (cardIds.length === 0) return null;
  return (
    <ul className="chat-card-chips" aria-label={t('chat.linkedCards')}>
      {cardIds.map(id => (
        <li key={id}>
          <CardChip data={data?.[id]} pending={isPending} />
        </li>
      ))}
    </ul>
  );
}
