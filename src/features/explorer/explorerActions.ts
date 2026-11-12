import { showError } from '../../app/errors/presentError';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { openQueryTab } from '../query/openQueryTab';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, unwrap, type MetaNode, type ObjectRef, type ScriptKind } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { documentNodeOf } from './documentRows';
import { isRelationKind, type ExplorerRow } from './explorerRows';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** "New query" on a connection, a database or any object of it. */
export function newQuery(connectionId: string, database: string | null): void {
  openQueryTab({ connectionId, database });
}

/** Opens a new query tab holding the script of a table (F-023). */
export async function scriptAs(
  connectionId: string,
  table: ObjectRef,
  script: Exclude<ScriptKind, 'qualifiedName'>,
): Promise<void> {
  try {
    const text = await unwrap(ipc.commands.scriptTable(connectionId, table, script));
    openQueryTab({ connectionId, database: table.database, initialText: text });
  } catch (error) {
    showError(error, { title: t('explorer.scriptFailed', { name: table.name }) });
  }
}

/**
 * What a double click (or Enter, or "Open data") on a table or view does: its rows in a table
 * tab (F-080), the one already showing it if there is one.
 */
export function openTable(connectionId: string, table: ObjectRef): Promise<void> {
  useTabsStore.getState().openTableTab(connectionId, table);
  return Promise.resolve();
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ variant: 'success', title: t('explorer.copied', { what }) });
  } catch (error) {
    showError(error, { title: t('explorer.copyFailed') });
  }
}

export function copyName(name: string): Promise<void> {
  return copyText(name, t('explorer.what.name'));
}

/** The name as the engine writes it, quoted and qualified by its dialect. */
export async function copyQualifiedName(connectionId: string, table: ObjectRef): Promise<void> {
  try {
    const name = await unwrap(ipc.commands.scriptTable(connectionId, table, 'qualifiedName'));
    await copyText(name, t('explorer.what.qualifiedName'));
  } catch (error) {
    showError(error, { title: t('explorer.copyFailed') });
  }
}

/** Drops the cached metadata of a node: the backend answers with `meta-refreshed`. */
export async function refreshNode(connectionId: string, node: MetaNode): Promise<void> {
  try {
    await unwrap(ipc.commands.refreshMeta(connectionId, node));
  } catch (error) {
    showError(error, { title: t('explorer.refreshFailed') });
  }
}

/** The node an explorer row stands for, in the backend's terms (`null`: nothing to refresh). */
export function metaNodeOf(row: ExplorerRow): MetaNode | null {
  switch (row.type) {
    case 'database':
      return { level: 'database', database: row.database.name };
    case 'schema':
      return { level: 'schema', database: row.database, schema: row.schema.name };
    case 'kind':
      return { level: 'objects', database: row.database, schema: row.schema, kind: row.kind };
    case 'object':
      return isRelationKind(row.object.kind)
        ? { level: 'table', table: row.ref }
        : {
            level: 'objects',
            database: row.ref.database,
            schema: row.ref.schema,
            kind: row.object.kind,
          };
    case 'pinned':
      if (row.pin.kind === null) {
        return { level: 'schema', database: row.pin.database, schema: row.pin.schema };
      }
      return isRelationKind(row.pin.kind)
        ? { level: 'table', table: row.ref }
        : {
            level: 'objects',
            database: row.pin.database,
            schema: row.pin.schema,
            kind: row.pin.kind,
          };
    case 'pinnedGroup':
      return null;
    case 'detailGroup':
    case 'column':
    case 'key':
    case 'foreignKey':
    case 'index':
    case 'check':
    case 'trigger':
      return { level: 'table', table: row.table };
    case 'status':
      return row.refresh;
    case 'docDatabase':
    case 'docCollection':
    case 'docGroup':
    case 'docField':
    case 'docIndex':
      return documentNodeOf(row);
  }
}

/** The database a row lives in, for "New query"; `null` on the connection's own row. */
export function databaseOf(row: ExplorerRow): string | null {
  switch (row.type) {
    case 'database':
      return row.database.name;
    case 'schema':
    case 'kind':
      return row.database;
    case 'object':
      return row.ref.database;
    case 'pinned':
      return row.pin.database;
    case 'pinnedGroup':
      return null;
    case 'detailGroup':
    case 'column':
    case 'key':
    case 'foreignKey':
    case 'index':
    case 'check':
    case 'trigger':
      return row.table.database;
    case 'status':
      return null;
    case 'docDatabase':
      return row.database.name;
    case 'docCollection':
    case 'docGroup':
    case 'docField':
    case 'docIndex':
      return row.database;
  }
}
