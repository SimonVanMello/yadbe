import { beforeEach, describe, expect, it } from 'vitest';

import { useLayoutStore } from '../../app/layout/layoutStore';
import { DEFAULT_PANELS } from '../../app/layout/panels';
import { queryClient } from '../../app/queryClient';
import { MOCK_CONNECTIONS, MOCK_ENGINES } from '../../ipc/mockData';
import { connectionKeys } from '../connections/connectionStore';
import { useSidebarView } from '../sidebar/sidebarViewStore';
import { nodeKeys } from './explorerRows';
import { useExplorerStore } from './explorerStore';
import { revealInExplorer } from './revealInExplorer';
import { useRevealStore } from './revealStore';

const open = (connectionId: string) => [
  ...(useExplorerStore.getState().expanded[connectionId] ?? []),
];

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryData(connectionKeys.all, { connections: MOCK_CONNECTIONS, groups: [] });
  queryClient.setQueryData(connectionKeys.engines, MOCK_ENGINES);
  useExplorerStore.setState({ expanded: {}, seeded: {} });
  useRevealStore.getState().clear();
  useSidebarView.getState().setView('history');
  useLayoutStore.setState({
    panels: { ...DEFAULT_PANELS, sidebar: { ...DEFAULT_PANELS.sidebar, collapsed: true } },
  });
});

describe('revealInExplorer', () => {
  it('opens every node above a PostgreSQL table: connection, database, schema, kind', () => {
    revealInExplorer('conn-local-pg', {
      database: 'app_dev',
      schema: 'shop',
      kind: 'table',
      name: 'orders',
    });
    expect(open('conn-local-pg')).toEqual([
      nodeKeys.root,
      nodeKeys.database('app_dev'),
      nodeKeys.schema('app_dev', 'shop'),
      nodeKeys.kind('app_dev', 'shop', 'table'),
    ]);
  });

  it('skips the levels the engine does not have', () => {
    revealInExplorer('conn-app-sqlite', {
      database: 'main',
      schema: null,
      kind: 'view',
      name: 'recent_notes',
    });
    expect(open('conn-app-sqlite')).toEqual([nodeKeys.root, nodeKeys.kind('main', null, 'view')]);
  });

  it('shows the sidebar on its Connections view and leaves a request for the tree', () => {
    revealInExplorer('conn-local-pg', {
      database: 'app_dev',
      schema: 'public',
      kind: 'function',
      name: 'now',
    });
    expect(useSidebarView.getState().view).toBe('connections');
    expect(useLayoutStore.getState().panels.sidebar.collapsed).toBe(false);
    expect(useRevealStore.getState().request).toMatchObject({
      connectionId: 'conn-local-pg',
      target: { name: 'now', schema: 'public', kind: 'function' },
    });
  });

  it('is a new request each time, even for the same object', () => {
    const target = { database: 'app_dev', schema: 'shop', kind: 'table', name: 'orders' } as const;
    revealInExplorer('conn-local-pg', target);
    const first = useRevealStore.getState().request?.seq;
    revealInExplorer('conn-local-pg', target);
    expect(useRevealStore.getState().request?.seq).not.toBe(first);
  });
});
