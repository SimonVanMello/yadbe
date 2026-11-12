import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { openActivity } from '../activity/activityActions';
import { copyConnectionString } from '../connections/connectionStringActions';
import { openMigrationsOfConnection } from '../migrations/migrationsActions';
import { findConnection } from '../query/connectionLookup';

/** The connection of the active tab, `undefined` on a welcome tab. */
function activeConnection() {
  const { connectionId } = selectActiveTab(useTabsStore.getState());
  return findConnection(connectionId);
}

/**
 * Registers the palette actions of the tools (F-140, F-143): the activity monitor and the
 * migrations timeline of the active tab's connection, and that connection copied as a .NET
 * connection string (never with its password: that is a choice of the connection menu).
 */
export function useToolActions(): void {
  useEffect(
    () =>
      registerActions({
        'activity.open': () => {
          const connection = activeConnection();
          if (!connection) return false;
          openActivity(connection.id);
          return undefined;
        },
        'migrations.open': () => {
          const connection = activeConnection();
          if (!connection) return false;
          void openMigrationsOfConnection(connection.id);
          return undefined;
        },
        'connection.copyAdoNet': () => {
          const connection = activeConnection();
          if (!connection) return false;
          void copyConnectionString(connection, 'adoNet', false);
          return undefined;
        },
        'connection.copyEfCore': () => {
          const connection = activeConnection();
          if (!connection) return false;
          void copyConnectionString(connection, 'efCore', false);
          return undefined;
        },
      }),
    [],
  );
}
