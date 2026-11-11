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
}

const NEEDS_QUERY_TAB: ReadonlySet<ActionId> = new Set([
  'query.run',
  'query.runStatement',
  'query.open',
  'query.save',
  'query.saveAs',
  'query.saveToLibrary',
  'query.updateSavedQuery',
  'tab.togglePin',
]);

/** Why `id` cannot run now (a message for the palette), or `null` when it can. */
export function disabledReason(id: ActionId, context: ActionContext): MessageKey | null {
  if (!context.registered.has(id)) return 'palette.disabled.unavailable';
  if (NEEDS_QUERY_TAB.has(id) && !context.queryTab) return 'palette.disabled.noQueryTab';
  if (id.startsWith('table.') && context.tableTab !== true) return 'palette.disabled.noTableTab';
  switch (id) {
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
    default:
      return null;
  }
}
