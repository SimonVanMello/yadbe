import { confirm } from '../../app/errors/confirmStore';
import { localize } from '../../app/errors/presentError';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { ipc, unwrap, YadbeIpcError, type KvDanger } from '../../ipc';
import { connectTo } from '../connections/connectionActions';
import { stateOf, useSessions } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { findConnection } from '../query/connectionLookup';
import { getQueryTabState } from '../query/queryTabStore';
import { getKvConsole, useKvConsoleStore } from './kvConsoleStore';
import { tr } from './kvText';

/** What a run sends: the whole text, the selected lines, or the line under the cursor. */
export type ConsoleScope = 'auto' | 'line';

/**
 * The lines a run sends, with the index of the first: the selected lines when there is a
 * selection (whole lines), the cursor's line for `line`, else everything.
 */
export function consoleLines(
  text: string,
  selection: { anchor: number; head: number },
  scope: ConsoleScope,
): { text: string; firstLine: number } {
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length - 1;
  const lines = text.split('\n');
  if (scope === 'line' || from !== to) {
    const first = lineOf(from);
    // A selection that ends at the start of a line does not take that line.
    const lastOffset = from !== to && text[to - 1] === '\n' ? to - 1 : to;
    const last = scope === 'line' ? lineOf(from) : lineOf(lastOffset);
    return { text: lines.slice(first, last + 1).join('\n'), firstLine: first };
  }
  return { text, firstLine: 0 };
}

async function confirmDangers(connection: ConnectionSummary, dangers: readonly KvDanger[]) {
  return confirm({
    title: tr(dangers.length === 1 ? 'keyValue.danger.title.one' : 'keyValue.danger.title', {
      count: dangers.length,
    }),
    description: tr('keyValue.danger.description', { connection: connection.name }),
    confirmLabel: tr('keyValue.danger.confirm'),
    danger: true,
    connection,
    items: dangers.map((danger) => ({
      label: danger.command,
      code: true,
      note: localize(danger.effect),
      danger: true,
    })),
  });
}

/**
 * Runs the console of a key-value query tab: connects first when needed, asks before dangerous
 * commands with their effect, then shows each command's reply in the console store.
 */
export async function runConsole(tabId: string, scope: ConsoleScope = 'auto'): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((entry) => entry.id === tabId);
  const connection = tab?.connectionId ? findConnection(tab.connectionId) : undefined;
  if (!connection || getKvConsole(tabId).running) return;
  const store = useKvConsoleStore.getState();
  const editor = getQueryTabState(tabId);
  const { text, firstLine } = consoleLines(editor.content, editor.selection, scope);
  if (text.trim() === '') return;
  store.update(tabId, { running: true, error: null });
  try {
    if (stateOf(useSessions.getState().sessions[connection.id]) !== 'connected') {
      const connected = await connectTo(connection);
      if (!connected) {
        store.update(tabId, { running: false });
        return;
      }
    }
    let outcome = await unwrap(ipc.commands.kvConsoleRun(tabId, connection.id, text, false));
    if (outcome.kind === 'needsConfirmation') {
      const shifted = outcome.dangers.map((danger) => ({
        ...danger,
        line: danger.line + firstLine,
      }));
      if (!(await confirmDangers(connection, shifted))) {
        store.update(tabId, { running: false });
        return;
      }
      outcome = await unwrap(ipc.commands.kvConsoleRun(tabId, connection.id, text, true));
    }
    if (outcome.kind === 'ran') {
      store.update(tabId, {
        running: false,
        entries: outcome.entries.map((entry) => ({ ...entry, line: entry.line + firstLine })),
        skipped: outcome.skipped,
        database: outcome.database,
        runId: getKvConsole(tabId).runId + 1,
      });
    }
  } catch (error) {
    store.update(tabId, {
      running: false,
      error: error instanceof YadbeIpcError ? error.error : null,
    });
  }
}

/** Stops a run after the command that runs now (a Redis command cannot be interrupted). */
export function stopConsole(tabId: string): void {
  void ipc.commands.kvConsoleStop(tabId);
}

/** A closed tab's console: its results and connection are freed. */
export function forgetConsole(tabId: string): void {
  if (!(tabId in useKvConsoleStore.getState().tabs)) return;
  useKvConsoleStore.getState().forget(tabId);
  void ipc.commands.kvConsoleClose(tabId);
}

/** Whether a tab is the console of a key-value connection (its query tab). */
export function isConsoleTab(tabId: string): boolean {
  const tab = useTabsStore.getState().tabs.find((entry) => entry.id === tabId);
  const connection = tab?.connectionId ? findConnection(tab.connectionId) : undefined;
  return connection?.family === 'keyValue';
}
