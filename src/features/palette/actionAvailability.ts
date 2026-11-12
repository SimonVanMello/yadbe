import type { ActionId } from '../../app/actions';
import type { MessageKey } from '../../i18n/i18n';

/** What decides whether an action can run right now. */
export interface ActionContext {
  /** The active tab is a query tab (a welcome tab has no editor). */
  queryTab: boolean;
  /** The active tab's text differs from the saved query it was opened from (F-050). */
  savedDiffers?: boolean;
  /** The active tab is a table tab (F-080). */
  tableTab?: boolean;
  /** The active tab's connection is up. */
  connected: boolean;
  running: boolean;
  transactionOpen: boolean;
  tabCount: number;
  closedTabCount: number;
  /** Actions something is registered for. */
  registered: ReadonlySet<ActionId>;
  /** The active tab is bound to a saved connection. */
  hasConnection?: boolean;
  /** The active connection's engine has sessions to watch (F-140). */
  activityMonitor?: boolean;
  /** The active connection's engine has the SQL formatter (F-049). */
  formatter?: boolean;
  /** The active connection's engine can list EF Core migrations (F-143). */
  efMigrations?: boolean;
  /** The active connection can be copied as a .NET connection string (F-143). */
  dotnetConnectionString?: boolean;
  /** The active connection's engine family (`sql` when unknown). */
  family?: string;
  /** The active connection's engine has DDL, "Script as" and a data import (SQL features). */
  ddl?: boolean;
  dataImport?: boolean;
}

/** What only a SQL editor or a SQL result has: a plan, a definition, a parameter set. */
const SQL_ONLY: ReadonlySet<ActionId> = new Set([
  'query.explain',
  'query.explainAnalyze',
  'query.goToDefinition',
  'query.runSameParameters',
  'query.openDefinitionData',
]);

const NEEDS_QUERY_TAB: ReadonlySet<ActionId> = new Set([
  'query.run',
  'query.runStatement',
  'query.open',
  'query.save',
  'query.saveAs',
  'query.saveToLibrary',
  'query.updateSavedQuery',
  'query.format',
  'query.explain',
  'query.explainAnalyze',
  'query.goToDefinition',
  'query.runSameParameters',
  'query.openDefinitionData',
  'tab.togglePin',
  'view.tabHistory',
]);

/** Why `id` cannot run now (a message for the palette), or `null` when it can. */
export function disabledReason(id: ActionId, context: ActionContext): MessageKey | null {
  if (!context.registered.has(id)) return 'palette.disabled.unavailable';
  if (NEEDS_QUERY_TAB.has(id) && !context.queryTab) return 'palette.disabled.noQueryTab';
  if (id.startsWith('table.') && context.tableTab !== true) return 'palette.disabled.noTableTab';
  if (SQL_ONLY.has(id) && context.family !== undefined && context.family !== 'sql') {
    return 'palette.disabled.sqlOnly';
  }
  switch (id) {
    case 'table.showDdl':
    case 'table.properties':
      return context.ddl === false ? 'palette.disabled.sqlOnly' : null;
    case 'table.import':
      return context.dataImport === false ? 'palette.disabled.sqlOnly' : null;
    case 'query.format':
      return context.formatter === false ? 'palette.disabled.unavailable' : null;
    case 'query.updateSavedQuery':
      return context.savedDiffers === true ? null : 'palette.disabled.noSavedQuery';
    case 'query.cancel':
      return context.running ? null : 'palette.disabled.notRunning';
    case 'query.commit':
    case 'query.rollback':
      return context.transactionOpen ? null : 'palette.disabled.noTransaction';
    case 'tab.reopenClosed':
      return context.closedTabCount > 0 ? null : 'palette.disabled.noClosedTab';
    case 'tab.next':
    case 'tab.previous':
      return context.tabCount > 1 ? null : 'palette.disabled.oneTab';
    case 'explorer.refresh':
      return context.connected ? null : 'palette.disabled.notConnected';
    case 'activity.open':
      if (context.activityMonitor === false) return 'palette.disabled.noSessions';
      return context.connected ? null : 'palette.disabled.notConnected';
    case 'migrations.open':
      if (context.efMigrations === false) return 'palette.disabled.unavailable';
      return context.connected ? null : 'palette.disabled.notConnected';
    case 'connection.copyAdoNet':
    case 'connection.copyEfCore':
      if (context.dotnetConnectionString === false) return 'palette.disabled.unavailable';
      return context.hasConnection === true ? null : 'palette.disabled.noConnection';
    default:
      return null;
  }
}
