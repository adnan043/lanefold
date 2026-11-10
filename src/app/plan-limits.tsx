import {useQueryClient} from '@tanstack/react-query';
import {useNavigate} from './nav';
import {useEffect, useRef} from 'react';

import {isPlanLimitCode, useT} from '../i18n';
import {useToast} from '../portal/ui';
import {ApiError} from './api';
import {useWorkspace} from './workspace';

/**
 * One place that turns a plan or limit answer from the server into a toast with a "See plans" action
 * (`/settings/billing`), whichever screen made the request. It watches every failed mutation. Owners and admins
 * get the action; everyone else is told to ask one (`billing.adminOnly`). Mounted once, inside the shell's providers.
 */
export function PlanLimitWatcher() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {current} = useWorkspace();
  const manager = current?.role === 'owner' || current?.role === 'admin';
  const latest = useRef({manager, t, toast, navigate});
  latest.current = {manager, t, toast, navigate};
  const lastAt = useRef(0);

  useEffect(
    () =>
      queryClient.getMutationCache().subscribe(event => {
        if (event.type !== 'updated' || event.action.type !== 'error') return;
        const error = event.action.error;
        if (!(error instanceof ApiError) || !isPlanLimitCode(error.code)) return;
        const now = Date.now();
        if (now - lastAt.current < 1500) return;
        lastAt.current = now;
        const {manager: canManage, t: tr, toast: pop, navigate: go} = latest.current;
        const message = canManage ? tr('plan.limitBody') : `${tr('plan.limitBody')} ${tr('billing.adminOnly')}`;
        pop.danger(message, canManage ? {action: {label: tr('plan.seePlans'), onSelect: () => void go({to: '/settings/billing'})}} : undefined);
      }),
    [queryClient]
  );
  return null;
}
