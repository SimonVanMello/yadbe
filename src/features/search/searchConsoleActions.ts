import { confirm } from '../../app/errors/confirmStore';
import { localize } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap, YadbeIpcError, type SearchDanger } from '../../ipc';
import { connectTo } from '../connections/connectionActions';
import { stateOf, useSessions } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { findConnection } from '../query/connectionLookup';
import { getQueryTabState } from '../query/queryTabStore';
import { runLines } from './consoleText';
import { getSearchConsole, useSearchConsoleStore } from './searchConsoleStore';

function tr(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

async function confirmDangers(connection: ConnectionSummary, dangers: readonly SearchDanger[]) {
  return confirm({
    title: tr(dangers.length === 1 ? 'search.danger.title.one' : 'search.danger.title', {
      count: dangers.length,
    }),
    description: tr('search.danger.description', { connection: connection.name }),
    confirmLabel: tr('search.danger.confirm'),
    danger: true,
    connection,
    items: dangers.map((danger) => ({
      label: `${danger.request} · ${tr('search.console.line', { line: danger.line + 1 })}`,
      code: true,
      note: localize(danger.effect),
      danger: true,
    })),
  });
}

/**
 * Runs requests of a search console: the selected ones, else the one under the cursor (`all`:
 * every request). Connects first when needed, asks before dangerous requests with their
 * effect, then shows the answers in the console store.
 */
export async function runSearchConsole(tabId: string, all = false): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((entry) => entry.id === tabId);
  const connection = tab?.connectionId ? findConnection(tab.connectionId) : undefined;
  if (!connection || getSearchConsole(tabId).running) return;
  const store = useSearchConsoleStore.getState();
  const editor = getQueryTabState(tabId);
  if (editor.content.trim() === '') return;
  const lines = runLines(editor.content, editor.selection, all);
  store.update(tabId, { running: true, error: null });
  try {
    if (stateOf(useSessions.getState().sessions[connection.id]) !== 'connected') {
      const connected = await connectTo(connection);
      if (!connected) {
        store.update(tabId, { running: false });
        return;
      }
    }
    let outcome = await unwrap(
      ipc.commands.searchConsoleRun(tabId, connection.id, editor.content, lines, false),
    );
    if (outcome.kind === 'needsConfirmation') {
      if (!(await confirmDangers(connection, outcome.dangers))) {
        store.update(tabId, { running: false });
        return;
      }
      outcome = await unwrap(
        ipc.commands.searchConsoleRun(tabId, connection.id, editor.content, lines, true),
      );
    }
    if (outcome.kind === 'ran') {
      const previous = getSearchConsole(tabId);
      // The last answer is the one to read first, as in Kibana.
      store.update(tabId, {
        running: false,
        responses: outcome.responses,
        selected: Math.max(0, outcome.responses.length - 1),
        skipped: outcome.skipped,
        failure: outcome.failure,
        runId: previous.runId + 1,
        sourceText: editor.content,
      });
    }
  } catch (error) {
    store.update(tabId, {
      running: false,
      error: error instanceof YadbeIpcError ? error.error : null,
    });
  }
}

/** Stops the request that runs (dropped, its task cancelled) and the ones after it. */
export function stopSearchConsole(tabId: string): void {
  void ipc.commands.searchCancel(tabId);
}

/** Whether a tab is the console of a search connection (its query tab). */
export function isSearchConsoleTab(tabId: string): boolean {
  const tab = useTabsStore.getState().tabs.find((entry) => entry.id === tabId);
  const connection = tab?.connectionId ? findConnection(tab.connectionId) : undefined;
  return connection?.family === 'search';
}
