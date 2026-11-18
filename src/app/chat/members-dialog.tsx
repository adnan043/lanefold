import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useMemo, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Avatar, EmptyState, ErrorNote, Icon, IconButton, LoadingBlock, Modal, SearchInput} from '../../portal/ui';
import {AvatarStack} from '../../portal/ui/chips';
import {useMe} from '../../portal/shared';
import {call} from '../api';
import {useNavigate} from '../nav';
import type {ConversationKind, ConversationT} from './api';

type Person = {id: number; name: string; role: string};
type Members = {scope: 'members' | 'workspace' | 'board'; items: Person[]};

/** Past this many people the list gets a search box. */
const SEARCH_FROM = 8;

/** `GET /conversations/:id/members`: a DM's or group's people (name + workspace role); a channel or board chat answers with its scope. */
const membersQuery = (conversationId: number) => ({
  queryKey: ['chat', 'members', conversationId],
  queryFn: () => call<Members>('GET', `/conversations/${conversationId}/members`),
  staleTime: 60_000,
});

/** The header's "N members" button and the list it opens. A channel is the whole workspace, so it says that instead of a count. */
export function MembersButton({conversationId, kind, title, workspaceId}: {conversationId: number; kind: ConversationKind; title: string; workspaceId: number}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const listed = kind === 'dm' || kind === 'group';
  const query = useQuery({...membersQuery(conversationId), enabled: listed || open});
  const count = query.data?.scope === 'members' ? query.data.items.length : undefined;
  const label = count !== undefined ? t('workspace.members', {count}) : t('chat.members');
  return (
    <>
      <button type="button" className="button button-ghost button-sm chat-members-button" aria-haspopup="dialog" aria-label={label} title={label} onClick={() => setOpen(true)}>
        {count !== undefined && query.data ? (
          <>
            <AvatarStack people={query.data.items.map(p => ({name: p.name}))} max={3} size="sm" label={label} />
            <span className="chat-members-count" aria-hidden="true">
              {count}
            </span>
          </>
        ) : (
          <>
            <Icon name="users" size={16} />
            <span aria-hidden="true">{label}</span>
          </>
        )}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('chat.members')} description={count !== undefined ? `${title} · ${label}` : title} size="sm">
        {query.isPending ? (
          <LoadingBlock rows={3} />
        ) : query.error ? (
          <ErrorNote error={query.error} />
        ) : query.data.scope === 'members' ? (
          <MemberList people={query.data.items} workspaceId={workspaceId} direct={kind === 'dm'} onLeave={() => setOpen(false)} />
        ) : (
          <EmptyState icon="users" title={query.data.scope === 'board' ? t('chat.membersBoard') : t('chat.membersEveryone')} />
        )}
      </Modal>
    </>
  );
}

function MemberList({people, workspaceId, direct, onLeave}: {people: Person[]; workspaceId: number; direct: boolean; onLeave: () => void}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const me = useMe().data?.viewer.id ?? undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState<number | null>(null);
  const [error, setError] = useState('');

  // You first, then everyone else by name (the server already sorts by name).
  const sorted = useMemo(() => [...people].sort((a, b) => Number(b.id === me) - Number(a.id === me)), [people, me]);
  const needle = q.trim().toLocaleLowerCase();
  const shown = needle ? sorted.filter(p => p.name.toLocaleLowerCase().includes(needle)) : sorted;

  /** Opens (or reuses) the DM with this person and goes there. */
  const message = async (person: Person) => {
    setOpening(person.id);
    setError('');
    try {
      const {conversation} = await call<{conversation: ConversationT}>('POST', `/workspaces/${workspaceId}/conversations`, {kind: 'dm', userIds: [person.id]});
      void queryClient.invalidateQueries({queryKey: ['chat', 'conversations', workspaceId]});
      onLeave();
      void navigate({to: '/chat', search: {c: conversation.id} as never});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="chat-members-wrap">
      {people.length > SEARCH_FROM && <SearchInput label={t('chat.searchPeople')} placeholder={t('chat.searchPeople')} value={q} onChange={e => setQ(e.target.value)} />}
      {error && (
        <p className="chat-members-error" role="alert">
          {error}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="muted chat-members-none">{t('chat.noMatches')}</p>
      ) : (
        <ul className="chat-members">
          {shown.map(person => {
            const isMe = person.id === me;
            return (
              <li key={person.id} className="chat-members-row">
                <Avatar name={person.name} size="md" />
                <span className="chat-members-name">
                  <bdi>{person.name}</bdi>
                  {isMe && <span className="chat-members-you">{t('members.you')}</span>}
                  {(person.role === 'owner' || person.role === 'admin') && <span className="chat-role-badge">{t(`members.role.${person.role}` as never)}</span>}
                </span>
                {!isMe && !direct && (
                  <IconButton
                    className="chat-members-action"
                    icon="message"
                    size="sm"
                    label={t('chat.composerPlaceholder', {name: person.name})}
                    pending={opening === person.id}
                    disabled={opening !== null}
                    onClick={() => void message(person)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
