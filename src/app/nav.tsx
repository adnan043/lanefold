import {Link as RouterLink, redirect as routerRedirect, useNavigate as useRouterNavigate} from '@tanstack/react-router';
import type {ComponentProps, ReactElement} from 'react';

/**
 * The `/app` router is a second router next to the portal's, and TanStack Router's types follow ONE
 * registered router (the portal's). These two wrappers keep the same runtime behaviour and accept this
 * app's own paths (`/boards`, `/b/$boardId`) as plain strings.
 */
type AppLinkProps = Omit<ComponentProps<typeof RouterLink>, 'to' | 'params' | 'search' | 'from'> & {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, unknown> | ((previous: Record<string, unknown>) => Record<string, unknown>);
};

type AppNavigate = (options: {
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, unknown> | ((previous: Record<string, unknown>) => Record<string, unknown>);
  replace?: boolean;
  hash?: string;
  resetScroll?: boolean;
}) => Promise<void>;

export const Link = RouterLink as unknown as (props: AppLinkProps) => ReactElement;

export function useNavigate(): AppNavigate {
  return useRouterNavigate() as unknown as AppNavigate;
}

/** `redirect()` for this app's own paths (see the note above). */
export function redirect(options: {to: string; replace?: boolean}): ReturnType<typeof routerRedirect> {
  return routerRedirect(options as unknown as Parameters<typeof routerRedirect>[0]);
}
