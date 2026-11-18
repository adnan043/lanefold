import {useQueries} from '@tanstack/react-query';
import {Link} from '../nav';

import {useT} from '../../i18n';
import {Icon} from '../../portal/ui';
import {cardRefQuery, type CardRefT} from './api';

/**
 * A card a message points at. The server sends ids only; titles come from batched reads of the cards the viewer may
 * see, so a private board's title never travels in the message. Absent (no access) or still loading: a plain "Card"
 * chip that is not a link.
 */
export function CardChip({data, pending}: {data?: CardRefT | null; pending: boolean}) {
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

/**
 * The chips under a message body. One cached query per card, and every card of the page rendered together is
 * fetched in ONE `/cards/refs` request (`cardRefQuery` batches them), never one request per message.
 */
export function CardChips({cardIds}: {cardIds: readonly number[]}) {
  const t = useT();
  const refs = useQueries({queries: cardIds.map(id => cardRefQuery(id))});
  if (cardIds.length === 0) return null;
  return (
    <ul className="chat-card-chips" aria-label={t('chat.linkedCards')}>
      {cardIds.map((id, i) => (
        <li key={id}>
          <CardChip data={refs[i]?.data} pending={refs[i]?.isPending ?? false} />
        </li>
      ))}
    </ul>
  );
}
