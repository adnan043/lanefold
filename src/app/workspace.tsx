import {useQuery} from '@tanstack/react-query';
import {createContext, type ReactNode, useCallback, useContext, useMemo, useState} from 'react';

import type {WorkspaceT} from './api';
import {workspacesQuery} from './queries';

const KEY = 'lf:workspace';

export function remembered(): number | null {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

type WorkspaceValue = {
  workspaces: WorkspaceT[] | undefined;
  /** The workspace the app is showing: the remembered one if I am still in it, else my first. */
  current: WorkspaceT | null;
  setCurrentId: (id: number) => void;
  pending: boolean;
  error: Error | null;
};

const Context = createContext<WorkspaceValue | null>(null);

/** Which workspace the visitor is in. Membership is read on the server for every request; this only picks one. */
export function WorkspaceProvider({children}: {children: ReactNode}) {
  const query = useQuery(workspacesQuery);
  const [id, setId] = useState<number | null>(remembered);
  const setCurrentId = useCallback((next: number) => {
    setId(next);
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      // Storage blocked: the choice lasts until the tab closes.
    }
  }, []);
  const value = useMemo<WorkspaceValue>(() => {
    const list = query.data;
    return {
      workspaces: list,
      current: list?.find(w => w.id === id) ?? list?.[0] ?? null,
      setCurrentId,
      pending: query.isPending,
      error: query.error,
    };
  }, [query.data, query.isPending, query.error, id, setCurrentId]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(Context);
  if (!value) throw new Error('useWorkspace() needs <WorkspaceProvider> (the shell mounts it).');
  return value;
}

/** Set by the screen showing one thing (a board) so the top bar's `<h1>` names it. */
const TitleContext = createContext<(title: string | null) => void>(() => {});
export const TitleSetter = TitleContext.Provider;
export const useSetPageTitle = () => useContext(TitleContext);
