import { queryClient } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import type { ObjectRef } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { showError } from '../../app/errors/presentError';
import { catalogQuery } from '../explorer/catalogCache';
import { fetchDatabases } from '../explorer/metaApi';
import { tableLabel } from '../table-data/tableNames';
import { historyTablesOf, pickHistoryTable } from './migrationsModel';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Shows the migrations of a history table (F-143): the tab already open for it, else a new one. */
export function openMigrations(connectionId: string, table: ObjectRef): string {
  return useTabsStore.getState().openToolTab(connectionId, { type: 'migrations', table });
}

/**
 * "Open the migrations timeline" for a connection: looks for the history table in the
 * connection's own database (through the catalog the palette and the autocomplete share), and
 * opens it. Says so when the database has none; with several (one per schema), opens the one of
 * the default schema and says which.
 */
export async function openMigrationsOfConnection(connectionId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const databases = await fetchDatabases(connectionId, controller.signal);
    const current = databases.find((database) => database.current) ?? databases[0];
    if (!current) {
      toast({ variant: 'info', title: t('migrations.none') });
      return false;
    }
    const catalog = await queryClient.query(catalogQuery({ connectionId, database: current.name }));
    const found = historyTablesOf(catalog);
    const table = pickHistoryTable(found, catalog.searchPath);
    if (!table) {
      toast({ variant: 'info', title: t('migrations.none') });
      return false;
    }
    if (found.length > 1) {
      toast({ variant: 'info', title: t('migrations.several', { table: tableLabel(table) }) });
    }
    openMigrations(connectionId, table);
    return true;
  } catch (error) {
    showError(error, { title: t('migrations.failed'), connectionId });
    return false;
  }
}
