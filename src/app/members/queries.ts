import {infiniteQueryOptions} from '@tanstack/react-query';

import {call} from '../api';
import type {MemberT} from '../chat/api';

export type JoinLinkT = {id: number; role: string; expiresAt: string; maxUses: number; uses: number; revoked: boolean; active: boolean; createdAt: string};
export type InviteT = {id: number; role: string; boundToEmail: boolean; emailStatus: 'queued' | 'sent' | 'failed' | 'not_configured' | null; emailSentAt: string | null; expiresAt: string; used: boolean; active: boolean; createdAt: string};
export type MembersPage = {items: MemberT[]; nextAfter: number | null; me: {role: string}};

export const membersListQuery = (workspaceId: number) =>
  infiniteQueryOptions({
    queryKey: ['members', workspaceId],
    queryFn: ({pageParam}) => call<MembersPage>('GET', `/workspaces/${workspaceId}/members${pageParam ? `?after=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: last => last.nextAfter ?? undefined,
  });

export const joinLinksQuery = (workspaceId: number) =>
  infiniteQueryOptions({
    queryKey: ['join-links', workspaceId],
    queryFn: ({pageParam}) => call<{items: JoinLinkT[]; nextBefore: number | null}>('GET', `/workspaces/${workspaceId}/join-links${pageParam ? `?before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: last => last.nextBefore ?? undefined,
  });

export const invitesQuery = (workspaceId: number) =>
  infiniteQueryOptions({
    queryKey: ['invites', workspaceId],
    queryFn: ({pageParam}) => call<{items: InviteT[]; nextBefore: number | null}>('GET', `/workspaces/${workspaceId}/invites${pageParam ? `?before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: last => last.nextBefore ?? undefined,
  });
