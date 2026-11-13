import { showError } from '../../app/errors/presentError';
import { isQueryTab, selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap, YadbeIpcError, type TextRange } from '../../ipc';
import { findConnection } from '../query/connectionLookup';
import { getQueryTabState, useQueryTabStore } from '../query/queryTabStore';
import { getScriptTab, useScriptStore } from './scriptStore';

/** The database a script tab starts on: the one chosen, else the connection's, else `admin`. */
export function scriptDatabase(tabId: string): string {
  const chosen = useQueryTabStore.getState().tabs[tabId]?.database;
  if (chosen) return chosen;
  const connectionId = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.connectionId;
  const own = findConnection(connectionId ?? null)?.definition.database;
  return own || 'admin';
}

/** Whether the tab is the query tab of a document connection (a mongosh editor). */
export function isScriptTab(tabId: string): boolean {
  const tab = useTabsStore.getState().tabs.find((entry) => entry.id === tabId);
  if (!tab || !isQueryTab(tab)) return false;
  return findConnection(tab.connectionId)?.family === 'document';
}

/** The active tab, when it is a mongosh editor. */
export function activeScriptTabId(): string | null {
  const tab = selectActiveTab(useTabsStore.getState());
  return isScriptTab(tab.id) ? tab.id : null;
}

/** What runs: the selection when there is one, else the whole text. */
export function runRange(content: string, anchor: number, head: number): TextRange | null {
  const from = Math.min(anchor, head, content.length);
  const to = Math.min(Math.max(anchor, head), content.length);
  if (from === to || content.slice(from, to).trim() === '') return null;
  return { from, to };
}

/**
 * Runs the tab's script (its selection, else all of it) as written. Dangerous operations it
 * meets arrive as `mongo-script-confirm` events while it waits (`answerConfirm`).
 */
export async function runScript(tabId: string): Promise<void> {
  const connectionId = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.connectionId;
  if (!connectionId || getScriptTab(tabId).running) return;
  const { content, selection } = getQueryTabState(tabId);
  if (content.trim() === '') return;
  const range = runRange(content, selection.anchor, selection.head);
  const database = scriptDatabase(tabId);
  const store = useScriptStore.getState();
  store.patch(tabId, {
    running: true,
    startedAt: performance.now(),
    live: [],
    error: null,
    confirm: null,
    sourceText: content,
  });
  try {
    const outcome = await unwrap(
      ipc.commands.mongoRunScript(tabId, connectionId, { database, text: content, range }),
    );
    const single = outcome.result?.kind === 'documents' && outcome.result.single;
    store.patch(tabId, {
      running: false,
      outcome,
      live: [],
      confirm: null,
      // Nothing to show but what it printed: the messages.
      pane: outcome.result === null && outcome.messages.length > 0 ? 'messages' : 'result',
      ...(single ? { view: 'documents' as const } : {}),
    });
    if (outcome.database !== database) {
      useQueryTabStore.getState().ensure(tabId);
      useQueryTabStore.getState().setDatabase(tabId, outcome.database);
    }
  } catch (error) {
    store.patch(tabId, {
      running: false,
      live: [],
      confirm: null,
      error: error instanceof YadbeIpcError ? error.error : null,
    });
    if (!(error instanceof YadbeIpcError)) showError(error);
  }
}

/** The user's answer to the dangerous operation the script waits on. */
export function answerConfirm(tabId: string, accepted: boolean): void {
  const pending = getScriptTab(tabId).confirm;
  if (!pending) return;
  useScriptStore.getState().patch(tabId, { confirm: null });
  void ipc.commands.mongoScriptConfirm(tabId, pending.requestId, accepted).catch(showError);
}

export function cancelScript(tabId: string): void {
  void ipc.commands.mongoCancel(tabId).catch(showError);
}
