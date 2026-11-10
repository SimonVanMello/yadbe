import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';

import { queryClient } from '../../app/queryClient';
import {
  ipc,
  type EngineInfo,
  type SavedConnection,
  type SessionInfo,
  type YadbeError,
} from '../../ipc';
import { connectionsApi } from './connectionsApi';
import {
  summarize,
  type ConnectionGroup,
  type ConnectionState,
  type ConnectionSummary,
  type Engine,
} from './model';

export const connectionKeys = {
  all: ['connections'] as const,
  engines: ['engines'] as const,
  keychain: ['keychain-status'] as const,
};

export interface ConnectionList {
  /** As saved, to update one definition and keep the rest. */
  saved: SavedConnection[];
  connections: ConnectionSummary[];
  groups: ConnectionGroup[];
}

const toList = (data: {
  connections: SavedConnection[];
  groups: ConnectionGroup[];
}): ConnectionList => ({
  saved: data.connections,
  connections: data.connections.map(summarize),
  groups: data.groups,
});

export function useConnectionList() {
  return useQuery({
    queryKey: connectionKeys.all,
    queryFn: () => connectionsApi.list(),
    select: toList,
  });
}

const NONE: ConnectionSummary[] = [];

/** The saved connections, empty until they are loaded. */
export function useConnections(): ConnectionSummary[] {
  return useConnectionList().data?.connections ?? NONE;
}

/** A saved connection by id, `undefined` for `null`, an unknown id or while loading. */
export function useConnection(id: string | null): ConnectionSummary | undefined {
  return useConnections().find((connection) => connection.id === id);
}

export function refreshConnections(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: connectionKeys.all });
}

const NO_ENGINES: EngineInfo[] = [];

/** The engines of this build and what they can do (F-002), which drive the connection form. */
export function useEngines() {
  const query = useQuery({
    queryKey: connectionKeys.engines,
    queryFn: () => connectionsApi.engines(),
    staleTime: Infinity,
  });
  return { ...query, engines: query.data ?? NO_ENGINES };
}

export function useEngineInfo(engine: Engine | null): EngineInfo | undefined {
  return useEngines().engines.find((info) => info.engine === engine);
}

/** Whether the OS keychain can hold passwords (F-005). Assumed available until known. */
export function useKeychainAvailable(): boolean {
  const query = useQuery({
    queryKey: connectionKeys.keychain,
    queryFn: () => connectionsApi.keychainStatus(),
    staleTime: Infinity,
  });
  return query.data?.available ?? true;
}

interface SessionStore {
  /** Every connection that is not closed (the backend only reports those). */
  sessions: Record<string, SessionInfo>;
  /** Last failed attempt of each connection, shown in its tabs until it works. */
  errors: Record<string, YadbeError>;
  apply: (session: SessionInfo) => void;
  replace: (sessions: SessionInfo[]) => void;
  forget: (id: string) => void;
  setError: (id: string, error: YadbeError) => void;
  clearError: (id: string) => void;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

/** Live state of each connection (F-013), fed by the backend. */
export const useSessions = create<SessionStore>()((set) => ({
  sessions: {},
  errors: {},
  apply: (session) => {
    set((current) => {
      const id = session.connectionId;
      const sessions =
        session.state === 'closed'
          ? without(current.sessions, id)
          : { ...current.sessions, [id]: session };
      // A failed first attempt or a dropped link keeps its reason; a working link clears it.
      const errors = session.error
        ? { ...current.errors, [id]: session.error }
        : session.state === 'connected'
          ? without(current.errors, id)
          : current.errors;
      return { sessions, errors };
    });
  },
  replace: (sessions) => {
    set({
      sessions: Object.fromEntries(sessions.map((session) => [session.connectionId, session])),
    });
  },
  forget: (id) => {
    set((current) => ({
      sessions: without(current.sessions, id),
      errors: without(current.errors, id),
    }));
  },
  setError: (id, error) => {
    set((current) => ({ errors: { ...current.errors, [id]: error } }));
  },
  clearError: (id) => {
    set((current) => ({ errors: without(current.errors, id) }));
  },
}));

export function stateOf(session: SessionInfo | undefined): ConnectionState {
  return session === undefined || session.state === 'closed' ? 'disconnected' : session.state;
}

export function useSession(id: string | null): SessionInfo | undefined {
  return useSessions((store) => (id === null ? undefined : store.sessions[id]));
}

export function useConnectionState(id: string | null): ConnectionState {
  return stateOf(useSession(id));
}

let feed: Promise<void> | undefined;

/** Loads the open sessions and follows the backend's changes; runs once per app launch. */
export function startConnectionFeed(): Promise<void> {
  feed ??= (async () => {
    ipc.events.subscribe('connectionStateChanged', ({ session }) => {
      useSessions.getState().apply(session);
      // A connection that just worked has a new "last used" date.
      if (session.state === 'connected') void refreshConnections();
    });
    try {
      useSessions.getState().replace(await connectionsApi.sessions());
    } catch (error) {
      console.warn('Connection states unavailable', error);
    }
  })();
  return feed;
}
