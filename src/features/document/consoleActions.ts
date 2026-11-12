import { showError } from '../../app/errors/presentError';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap, YadbeIpcError } from '../../ipc';
import { findConnection } from '../query/connectionLookup';
import { useQueryTabStore } from '../query/queryTabStore';
import { getConsoleTab, useConsoleStore } from './consoleStore';

/** The database a console tab runs in: the one chosen, else the connection's, else `admin`. */
export function consoleDatabase(tabId: string): string {
  const chosen = useQueryTabStore.getState().tabs[tabId]?.database;
  if (chosen) return chosen;
  const connectionId = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.connectionId;
  const own = findConnection(connectionId ?? null)?.definition.database;
  return own || 'admin';
}

async function send(
  tabId: string,
  connectionId: string,
  database: string,
  command: string,
  confirmed: boolean,
): Promise<void> {
  const store = useConsoleStore.getState();
  store.patch(tabId, { running: true, error: null, confirm: null });
  try {
    const outcome = await unwrap(
      ipc.commands.mongoRunCommand(tabId, connectionId, database, command, confirmed),
    );
    if (outcome.status === 'confirm') {
      store.patch(tabId, {
        running: false,
        confirm: { command, database, danger: outcome.danger },
      });
      return;
    }
    store.patch(tabId, {
      running: false,
      outcome: {
        documents: outcome.documents,
        cursor: outcome.cursor,
        truncated: outcome.truncated,
        durationMs: outcome.durationMs,
      },
      // A reply is one document: its tree reads better than a one-row grid.
      ...(outcome.cursor ? {} : { view: 'documents' as const }),
    });
  } catch (error) {
    store.patch(tabId, {
      running: false,
      error: error instanceof YadbeIpcError ? error.error : null,
    });
    if (!(error instanceof YadbeIpcError)) showError(error);
  }
}

/** Runs the console's command (one JSON command, sent as written). */
export function runConsole(tabId: string): Promise<void> {
  const connectionId = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.connectionId;
  if (!connectionId || getConsoleTab(tabId).running) return Promise.resolve();
  const command = useQueryTabStore.getState().tabs[tabId]?.content ?? '';
  if (command.trim() === '') return Promise.resolve();
  return send(tabId, connectionId, consoleDatabase(tabId), command, false);
}

/** Runs the dangerous command the user confirmed, as it was shown. */
export function confirmConsole(tabId: string): Promise<void> {
  const connectionId = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.connectionId;
  const pending = getConsoleTab(tabId).confirm;
  if (!connectionId || !pending) return Promise.resolve();
  return send(tabId, connectionId, pending.database, pending.command, true);
}

export function dismissConfirm(tabId: string): void {
  useConsoleStore.getState().patch(tabId, { confirm: null });
}

export function cancelConsole(tabId: string): void {
  void ipc.commands.mongoCancel(tabId).catch(showError);
}
