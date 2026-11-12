import { beforeEach, describe, expect, it } from 'vitest';

import {
  connectionKeys,
  startConnectionFeed,
  stateOf,
  useSessions,
} from '../features/connections/connectionStore';
import { getQueryTabState, useQueryTabStore } from '../features/query/queryTabStore';
import { mockBackend } from '../ipc/mockClient';
import { MOCK_CONNECTIONS, MOCK_ENGINES } from '../ipc/mockData';
import type { LaunchRequest, ParsedConnectionString } from '../ipc';
import { useToastStore } from '../ui/toastStore';
import { applyLaunchRequests, findSavedMatch, handleLaunchRequests } from './launch';
import { queryClient } from './queryClient';
import { useShellStore } from './shellStore';
import { selectActiveTab, useTabsStore } from './tabs/tabsStore';

const PG = 'conn-local-pg';
const SCRIPT = '/home/ana/queries/orders-report.sql';

function parsed(fields: Partial<ParsedConnectionString>): ParsedConnectionString {
  return {
    mongo: null,
    search: null,
    format: 'url',
    engine: 'postgres',
    host: null,
    port: null,
    database: null,
    username: null,
    filePath: null,
    tlsMode: null,
    caCertPath: null,
    options: [],
    passwordId: null,
    ignoredKeys: [],
    ...fields,
  };
}

const connection = (fields: Partial<ParsedConnectionString>): LaunchRequest => ({
  kind: 'connection',
  parsed: parsed(fields),
  passwordIgnored: false,
});

const toasts = () => useToastStore.getState().toasts;

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  queryClient.clear();
  queryClient.setQueryData(connectionKeys.all, { connections: MOCK_CONNECTIONS, groups: [] });
  const id = useTabsStore.getState().newTab();
  useTabsStore.setState((state) => ({
    tabs: state.tabs.filter((tab) => tab.id === id),
    activeTabId: id,
    closedTabs: [],
    lastOrdinal: 1,
  }));
  useQueryTabStore.setState({ tabs: {} });
  useShellStore.getState().closeConnectionDialog();
  useSessions.setState({ sessions: {}, errors: {} });
  useToastStore.setState({ toasts: [] });
  await startConnectionFeed();
});

describe('findSavedMatch', () => {
  const saved = MOCK_CONNECTIONS;
  const idOf = (fields: Partial<ParsedConnectionString>) =>
    findSavedMatch(parsed(fields), saved, MOCK_ENGINES)?.id ?? null;

  it('matches on what the URL states, the default port standing in for a missing one', () => {
    expect(idOf({ host: 'localhost', database: 'app_dev', username: 'postgres' })).toBe(PG);
    expect(idOf({ host: 'LOCALHOST', port: 5432, database: 'app_dev' })).toBe(PG);
    expect(idOf({ host: 'localhost' })).toBe(PG);
  });

  it('does not match another database, user, port, host or engine', () => {
    expect(idOf({ host: 'localhost', database: 'other' })).toBeNull();
    expect(idOf({ host: 'localhost', username: 'someone' })).toBeNull();
    expect(idOf({ host: 'localhost', port: 5433 })).toBeNull();
    expect(idOf({ host: 'elsewhere.example.com' })).toBeNull();
    expect(idOf({ engine: 'mysql', host: 'localhost', database: 'app_dev' })).toBeNull();
    expect(idOf({ engine: null, host: 'localhost' })).toBeNull();
    expect(idOf({})).toBeNull();
  });

  it('matches a file engine on its path', () => {
    const file = MOCK_CONNECTIONS.find((c) => c.definition.engine === 'sqlite');
    expect(file).toBeDefined();
    expect(idOf({ engine: 'sqlite', filePath: file?.definition.filePath ?? '' })).toBe(file?.id);
    expect(idOf({ engine: 'sqlite', filePath: '/nowhere.db' })).toBeNull();
  });
});

describe('applyLaunchRequests', () => {
  it('opens a query tab on the saved connection a URL matches, and connects it', async () => {
    await applyLaunchRequests([connection({ host: 'localhost', database: 'app_dev' })]);
    expect(selectActiveTab(useTabsStore.getState()).connectionId).toBe(PG);
    expect(useShellStore.getState().connectionDialog).toBeNull();
    await expect.poll(() => stateOf(useSessions.getState().sessions[PG])).toBe('connected');
  });

  it('opens the connection form, filled in and without password, when nothing matches', async () => {
    await applyLaunchRequests([
      {
        kind: 'connection',
        parsed: parsed({ host: 'db.example.com', database: 'shop', username: 'app' }),
        passwordIgnored: true,
      },
    ]);
    const request = useShellStore.getState().connectionDialog;
    expect(request).toMatchObject({ connectionId: null });
    expect(request?.parsed).toMatchObject({ host: 'db.example.com', passwordId: null });
    // The ignored password is said, not echoed.
    expect(toasts().at(-1)).toMatchObject({ variant: 'warning' });
    expect(JSON.stringify(toasts())).not.toContain('hunter2');
  });

  it('opens scripts in new tabs bound to the active tab connection, without running them', async () => {
    const first = selectActiveTab(useTabsStore.getState()).id;
    useTabsStore.setState((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === first ? { ...tab, connectionId: PG } : tab)),
    }));
    await applyLaunchRequests([
      { kind: 'sqlFile', path: SCRIPT },
      { kind: 'sqlFile', path: SCRIPT },
    ]);
    const tab = selectActiveTab(useTabsStore.getState());
    expect(tab).toMatchObject({ connectionId: PG });
    expect(tab.id).not.toBe(first);
    const state = getQueryTabState(tab.id);
    expect(state.filePath).toBe(SCRIPT);
    expect(state.content).toContain('from orders o');
    // The same file twice is one tab.
    expect(
      Object.values(useQueryTabStore.getState().tabs).filter((t) => t.filePath === SCRIPT),
    ).toHaveLength(1);
    expect(toasts()).toHaveLength(0);
  });

  it('opens a script on the most recently used connection when no tab has one', async () => {
    await applyLaunchRequests([{ kind: 'sqlFile', path: SCRIPT }]);
    const recent = [...MOCK_CONNECTIONS].sort(
      (a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0),
    )[0];
    expect(selectActiveTab(useTabsStore.getState()).connectionId).toBe(recent?.id);
  });

  it('puts the scripts on the connection the URL named', async () => {
    await applyLaunchRequests([
      { kind: 'sqlFile', path: SCRIPT },
      connection({ host: 'localhost', database: 'app_dev' }),
    ]);
    const tab = selectActiveTab(useTabsStore.getState());
    expect(tab.connectionId).toBe(PG);
    expect(getQueryTabState(tab.id).filePath).toBe(SCRIPT);
  });

  it('says why an argument was not used', async () => {
    await applyLaunchRequests([
      { kind: 'rejected', reason: 'notAScript', argument: 'data.csv' },
      { kind: 'rejected', reason: 'fileNotFound', argument: '/x/missing.sql' },
      { kind: 'rejected', reason: 'invalidUrl', argument: null },
    ]);
    // A connection attempt of an earlier test may still be reporting: only ours are checked.
    const titles = toasts().map((toast) => toast.title);
    expect(titles.some((title) => title.includes('data.csv'))).toBe(true);
    expect(titles.some((title) => title.includes('missing.sql'))).toBe(true);
    expect(titles.some((title) => /connection URL/.test(title))).toBe(true);
  });

  it('reports a script that cannot be read and opens no tab for it', async () => {
    await applyLaunchRequests([{ kind: 'sqlFile', path: '/home/ana/queries/gone.sql' }]);
    expect(Object.keys(useQueryTabStore.getState().tabs)).toHaveLength(0);
    expect(toasts().at(-1)).toMatchObject({ variant: 'error' });
  });

  it('does nothing without a request', async () => {
    await applyLaunchRequests([]);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });
});

describe('handleLaunchRequests', () => {
  it('takes the backend requests once', async () => {
    (globalThis as { __YADBE_MOCK_LAUNCH__?: LaunchRequest[] }).__YADBE_MOCK_LAUNCH__ = [
      { kind: 'sqlFile', path: SCRIPT },
    ];
    await handleLaunchRequests();
    expect(Object.values(useQueryTabStore.getState().tabs).some((t) => t.filePath === SCRIPT)).toBe(
      true,
    );
    const tabs = useTabsStore.getState().tabs.length;
    await handleLaunchRequests();
    expect(useTabsStore.getState().tabs).toHaveLength(tabs);
  });
});
