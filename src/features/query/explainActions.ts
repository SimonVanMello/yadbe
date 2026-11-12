import { confirm } from '../../app/errors/confirmStore';
import { queryClient } from '../../app/queryClient';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, type EngineInfo, type ExecuteScope } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { connectTo } from '../connections/connectionActions';
import { connectionKeys } from '../connections/connectionStore';
import { tokenize } from '../completion/sqlTokens';
import { findConnection } from './connectionLookup';
import { dangerKindKey } from './dangerGuard';
import { classifyStatement } from './dangerousStatements';
import { isActive } from './executionModel';
import { getTabExecution } from './executionStore';
import { usePlanStore, isExplaining } from './planStore';
import { parameterValuesFor } from './queryActions';
import { getQueryTabState } from './queryTabStore';
import { selectedRange } from './runScope';
import { useTabsStore } from '../../app/tabs/tabsStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Words a statement may start with and still only read. */
const READ_STARTS = new Set(['select', 'with', 'values', 'table', 'show', 'explain']);
/** Words that make it write wherever they appear (writable CTEs, `SELECT … INTO`). */
const WRITE_WORDS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'into',
  'create',
  'drop',
  'alter',
  'truncate',
  'call',
  'exec',
  'execute',
  'grant',
  'revoke',
]);

/**
 * Whether running `sql` may change data or the schema: what "Explain analyze" asks about
 * first, since it runs the statement. Conservative: anything not proven a read counts.
 */
export function mayWrite(sql: string): boolean {
  const words = tokenize(sql, { open: '"', close: '"' })
    .filter((token) => token.kind === 'word')
    .map((token) => token.lower);
  const [first] = words;
  if (first === undefined || !READ_STARTS.has(first)) return true;
  return words.some((word) => WRITE_WORDS.has(word));
}

function engineInfo(engine: string): EngineInfo | undefined {
  return queryClient
    .getQueryData<EngineInfo[]>(connectionKeys.engines)
    ?.find((info) => info.engine === engine);
}

/** The statement to explain: the selection when there is one, else the one under the cursor. */
function explainScope(
  tabId: string,
): Extract<ExecuteScope, { kind: 'range' | 'statementAt' }> | null {
  const { content, selection } = getQueryTabState(tabId);
  if (content.trim() === '') return null;
  const range = selectedRange(selection);
  if (range && content.slice(range.from, range.to).trim() !== '')
    return { kind: 'range', ...range };
  return { kind: 'statementAt', offset: Math.min(selection.head, content.length) };
}

/**
 * Explains the statement under the cursor (F-053) on the tab's connection: the estimated plan,
 * or with `analyze` the actual one, which runs the statement (asked first when it may write).
 * The plan replaces the results in the results area.
 */
export async function explainQuery(tabId: string, analyze: boolean): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  const connection = findConnection(tab?.connectionId ?? null);
  if (!tab || !connection) return;
  if (isActive(getTabExecution(tabId).status) || isExplaining(tabId)) {
    toast({ variant: 'info', title: t('query.plan.busy') });
    return;
  }
  const capabilities = engineInfo(connection.engine)?.capabilities;
  if (analyze && capabilities?.explainAnalyze === false) {
    toast({ variant: 'info', title: t('query.plan.noAnalyze') });
    return;
  }
  const scope = explainScope(tabId);
  if (!scope) {
    toast({ variant: 'info', title: t('query.nothingToRun') });
    return;
  }
  if (!(await connectTo(connection))) return;
  const { content: text, database } = getQueryTabState(tabId);

  const parameters = await parameterValuesFor(tabId, connection.engine, text, scope, false);
  if (parameters === null) return;

  if (analyze && !connection.readOnly) {
    const statement =
      scope.kind === 'range'
        ? text.slice(scope.from, scope.to)
        : await ipc.commands
            .statementAt(connection.engine, text, scope.offset)
            .then((r) => (r.status === 'ok' && r.data ? text.slice(r.data.from, r.data.to) : ''));
    if (mayWrite(statement)) {
      const danger = classifyStatement(statement);
      const confirmed = await confirm({
        title: t('query.plan.analyzeWrites.title'),
        description: t('query.plan.analyzeWrites.description'),
        confirmLabel: t('query.plan.analyzeWrites.confirm'),
        danger: true,
        connection,
        items: [
          {
            label: statement.trim(),
            code: true,
            note: danger === null ? t('query.plan.analyzeWrites.note') : t(dangerKindKey(danger)),
            danger: true,
          },
        ],
      });
      if (!confirmed) return;
    }
  }

  const store = usePlanStore.getState();
  store.set(tabId, { status: 'running', analyze, startedAt: Date.now() });
  const result = await ipc.commands.explainQuery({
    tabId,
    connectionId: connection.id,
    database,
    text,
    scope,
    analyze,
    parameters,
  });
  // A newer explain (or the tab closing) replaced this one meanwhile: nothing to show.
  const current = usePlanStore.getState().plans[tabId];
  if (current?.status !== 'running') return;
  usePlanStore
    .getState()
    .set(
      tabId,
      result.status === 'ok'
        ? { status: 'done', analyze, result: result.data }
        : { status: 'failed', analyze, error: result.error },
    );
}
