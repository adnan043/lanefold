import {keepPreviousData, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Button, Checkbox, ErrorNote, Field, LoadingBlock, Modal, SearchInput, SegmentedControl, useForm} from '../../portal/ui';
import {useMe} from '../../portal/shared';
import {call} from '../api';
import {type ConversationT, memberSearchQuery, type PersonHit, useDebounced} from './api';

type Kind = 'channel' | 'dm' | 'group';

/** New channel, direct message or group. Viewers only message people directly (the server enforces it too). */
export function NewConversationModal({workspaceId, role, open, onClose, onCreated}: {workspaceId: number; role: string; open: boolean; onClose: () => void; onCreated: (c: ConversationT) => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const queryClient = useQueryClient();
  const me = useMe().data?.viewer.id;
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim());
  const people = useQuery({...memberSearchQuery(workspaceId, term), enabled: open, placeholderData: keepPreviousData});
  /** Names of the people picked so far (a search result can scroll out of the list). */
  const [names, setNames] = useState<Record<number, string>>({});
  const canGroup = role !== 'viewer';
  const [kind, setKind] = useState<Kind>(canGroup ? 'channel' : 'dm');
  const [peer, setPeer] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [status, setStatus] = useState('');
  const form = useForm({name: ''}, {name: kind === 'dm' ? [] : [rules.required(t('chat.nameRequired')), rules.maxLength(80, t('chat.nameTooLong'))]});
  const others: PersonHit[] = (people.data ?? []).filter(p => p.userId !== me && p.name);
  const choose = (p: PersonHit, on: boolean) => {
    setNames(map => ({...map, [p.userId]: p.name}));
    if (kind === 'dm') setPeer(on ? String(p.userId) : '');
    else setPicked(list => (on ? (list.includes(p.userId) ? list : [...list, p.userId]) : list.filter(id => id !== p.userId)));
  };
  const isChosen = (id: number) => (kind === 'dm' ? peer === String(id) : picked.includes(id));
  // Picked people stay on top even when the search no longer shows them.
  const chosenIds = kind === 'dm' ? (peer ? [Number(peer)] : []) : picked;
  const extra = chosenIds.filter(id => !others.some(p => p.userId === id)).map(id => ({userId: id, name: names[id] ?? '', role: '', isMe: false}));
  const rows: PersonHit[] = [...extra, ...others];

  const create = useMutation({
    mutationFn: () =>
      call<{conversation: ConversationT}>('POST', `/workspaces/${workspaceId}/conversations`, {
        kind,
        ...(kind === 'channel' ? {name: form.values.name.trim()} : {}),
        ...(kind === 'group' ? {name: form.values.name.trim(), userIds: picked} : {}),
        ...(kind === 'dm' ? {userIds: [Number(peer)]} : {}),
      }),
    onSuccess: async ({conversation}) => {
      await queryClient.invalidateQueries({queryKey: ['chat', 'conversations', workspaceId]});
      close(true);
      onCreated(conversation);
    },
    onError: error => {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error));
      setStatus(errorMessage(error));
    },
  });

  const close = (force = false) => {
    if (create.isPending && !force) return;
    form.reset();
    setPeer('');
    setPicked([]);
    setNames({});
    setSearch('');
    setStatus('');
    onClose();
  };

  const submit = form.submit(() => {
    setStatus('');
    if (kind === 'dm' && !peer) return setStatus(t('chat.choosePerson'));
    if (kind === 'group' && (picked.length < 1 || picked.length > 40)) return setStatus(t('chat.chooseGroup'));
    create.mutate();
  });

  return (
    <Modal
      open={open}
      onClose={() => close()}
      dismissible={!create.isPending}
      title={t('chat.newTitle')}
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={() => close()}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="new-conversation-form" pending={create.isPending} pendingLabel={t('common.creating')} disabled={form.blocked}>
            {t('common.create')}
          </Button>
        </>
      }>
      <form id="new-conversation-form" className="lf-form" noValidate onSubmit={submit}>
        {canGroup && (
          <SegmentedControl<Kind>
            label={t('chat.kind')}
            value={kind}
            onChange={next => {
              setKind(next);
              setStatus('');
            }}
            options={[
              {value: 'channel', label: t('chat.kind.channel')},
              {value: 'dm', label: t('chat.kind.dm')},
              {value: 'group', label: t('chat.kind.group')},
            ]}
          />
        )}
        {kind !== 'dm' && (
          <Field id="f-name" label={t('chat.nameLabel')} error={form.error('name')}>
            <input type="text" maxLength={120} placeholder={kind === 'channel' ? t('chat.namePlaceholder') : t('chat.groupPlaceholder')} {...form.field('name')} />
          </Field>
        )}
        {kind !== 'channel' && (
          <fieldset className="chat-people-pick">
            <legend>{kind === 'dm' ? t('chat.person') : t('chat.groupMembers')}</legend>
            <SearchInput label={t('chat.searchPeople')} placeholder={t('chat.searchPeople')} maxLength={40} value={search} onChange={event => setSearch(event.target.value)} />
            {people.isPending ? (
              <LoadingBlock rows={2} />
            ) : people.error ? (
              <ErrorNote error={new Error(errorMessage(people.error))} />
            ) : (
              <>
                {rows.map(p => (
                  <Checkbox key={p.userId} label={<bdi>{p.name}</bdi>} checked={isChosen(p.userId)} onChange={on => choose(p, on)} />
                ))}
                {rows.length === 0 && <p className="muted">{term ? t('chat.noMatches') : t('chat.noOthers')}</p>}
              </>
            )}
          </fieldset>
        )}
        {status && (
          <p className="field-error" role="alert">
            {status}
          </p>
        )}
      </form>
    </Modal>
  );
}
