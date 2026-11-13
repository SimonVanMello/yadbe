import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import type { ShellTab } from '../../app/tabs/tabsStore';
import { useShortcutOf } from '../../app/useShortcutOf';
import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type ScriptOutcome } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { connectTo } from '../connections/connectionActions';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { requestKey } from '../explorer/metaKeys';
import { QuerySplit } from '../query/QuerySplit';
import { useQueryTabStore } from '../query/queryTabStore';
import { useQueryUiStore } from '../query/queryUiStore';
import type { DocumentViewMode } from './collectionStore';
import { DangerDialog } from './DangerDialog';
import { DocumentResults } from './DocumentResults';
import { answerConfirm, scriptDatabase } from './scriptActions';
import styles from './ScriptConsole.module.css';
import { ScriptEditor } from './ScriptEditor';
import { ScriptMessages } from './ScriptMessages';
import { useScriptStore, useScriptTab, type ScriptPane } from './scriptStore';

/**
 * The query tab of a document connection: a mongosh editor. The script runs as written in the
 * backend's JavaScript engine (Mod+Enter: the selection, else all of it); its last expression
 * is the result (documents in a grid or as trees, or text), what it printed goes to the
 * messages. Every operation it makes passes the backend's gate: refused on a read-only
 * connection, dangerous ones confirmed here while the script waits.
 */
export function ScriptConsole({
  tab,
  connection,
}: {
  tab: ShellTab;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const id = useId();
  const shortcutOf = useShortcutOf();
  const ratio = useQueryUiStore((state) => state.resultsRatio);
  const container = useRef<HTMLDivElement>(null);
  const state = useConnectionState(connection.id);
  const chosen = useQueryTabStore((store) => store.tabs[tab.id]?.database ?? null);
  const run = useScriptTab(tab.id);
  const connected = state === 'connected';
  const database = chosen ?? scriptDatabase(tab.id);
  // The explorer's list, from the same cache: opening the tab does not read it twice.
  const databases = useQuery({
    queryKey: requestKey(connection.id, { type: 'docDatabases' }),
    queryFn: () => unwrap(ipc.commands.mongoListDatabases(connection.id)),
    enabled: connected,
    staleTime: Infinity,
  });
  const names = [...new Set([database, ...(databases.data ?? []).map((info) => info.name)])].sort();

  useEffect(() => {
    useQueryTabStore.getState().ensure(tab.id);
  }, [tab.id]);

  return (
    <div ref={container} className={styles.view} data-testid="script-console">
      {!connected && (
        <div className={styles.notice} role="status">
          <Icon name="info" />
          <span>{t('mongo.script.notConnected', { name: connection.name })}</span>
          <Button
            size="sm"
            disabled={state === 'connecting' || state === 'reconnecting'}
            onClick={() => {
              void connectTo(connection);
            }}
          >
            {t('tableData.connect')}
          </Button>
        </div>
      )}
      <div className={styles.bar}>
        <label className={styles.database} htmlFor={`${id}-database`}>
          <Icon name="database" />
          <Select
            id={`${id}-database`}
            aria-label={t('mongo.script.database')}
            value={database}
            options={names.map((name) => ({ value: name, label: name }))}
            onChange={(name) => {
              useQueryTabStore.getState().ensure(tab.id);
              useQueryTabStore.getState().setDatabase(tab.id, name);
            }}
          />
        </label>
        <span className={styles.hint}>
          <Kbd shortcut={shortcutOf('query.run')} /> {t('mongo.script.hint')}
        </span>
      </div>
      <div className={styles.editorPane}>
        <ScriptEditor key={tab.id} tabId={tab.id} />
      </div>
      <QuerySplit container={container} />
      <div
        className={styles.output}
        style={{ flexBasis: `${String(ratio * 100)}%` }}
        aria-busy={run.running}
      >
        <Output tabId={tab.id} />
      </div>
      <DangerDialog
        danger={run.confirm?.danger ?? null}
        onCancel={() => {
          answerConfirm(tab.id, false);
        }}
        onConfirm={() => {
          answerConfirm(tab.id, true);
        }}
      />
    </div>
  );
}

function Summary({ outcome }: { outcome: ScriptOutcome }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const result = outcome.result;
  const parts: string[] = [];
  if (result?.kind === 'documents') {
    parts.push(
      result.single
        ? t('mongo.script.oneDocument')
        : t('mongo.console.documents', { count: result.documents.count }),
    );
    if (result.truncated) parts.push(t('mongo.script.truncated'));
  }
  parts.push(t('mongo.console.duration', { ms: formatNumber(locale, outcome.durationMs ?? 0) }));
  return (
    <span className={styles.summary} data-testid="script-summary">
      {parts.join(' · ')}
    </span>
  );
}

function Output({ tabId }: { tabId: string }) {
  const t = useT();
  const run = useScriptTab(tabId);
  const { outcome, error, running, pane, view, live } = run;
  const failure = outcome?.failure ?? null;
  const exception = failure?.error.code === 'scriptError' ? failure.error.detail : null;
  const result = outcome?.result ?? null;
  const messages = running ? live : (outcome?.messages ?? []);
  const messageCount = messages.length;

  return (
    <>
      <div className={styles.status}>
        <SegmentedControl<ScriptPane>
          label={t('mongo.script.pane')}
          value={pane}
          options={[
            { value: 'result', label: t('mongo.script.result') },
            {
              value: 'messages',
              label:
                messageCount > 0
                  ? t('mongo.script.messagesCount', { count: messageCount })
                  : t('mongo.script.messages'),
            },
          ]}
          onChange={(next) => {
            useScriptStore.getState().patch(tabId, { pane: next });
          }}
        />
        {pane === 'result' && result?.kind === 'documents' && (
          <SegmentedControl<DocumentViewMode>
            label={t('mongo.view.label')}
            value={view}
            options={[
              { value: 'grid', label: t('mongo.view.grid') },
              { value: 'documents', label: t('mongo.view.documents') },
            ]}
            onChange={(next) => {
              useScriptStore.getState().patch(tabId, { view: next });
            }}
          />
        )}
        {running ? (
          <span className={styles.summary} data-testid="script-running">
            <Spinner /> {t('mongo.script.running')}
          </span>
        ) : (
          outcome && <Summary outcome={outcome} />
        )}
      </div>
      {error && <ErrorPanel compact title={t('mongo.script.failedToStart')} error={error} />}
      {!running && failure && (
        <div className={styles.failure} data-code={failure.error.code} data-testid="script-failure">
          <ErrorPanel
            compact
            title={t('mongo.script.failed')}
            // A JavaScript exception is the message itself: shown, not folded under Details.
            error={exception === null ? failure.error : { ...failure.error, detail: null }}
          >
            {exception !== null && <code className={styles.exception}>{exception}</code>}
            {failure.position && (
              <p className={styles.position}>
                {t('mongo.script.position', {
                  line: failure.position.line,
                  column: failure.position.column,
                })}
              </p>
            )}
          </ErrorPanel>
        </div>
      )}
      <div className={styles.paneBody}>
        {pane === 'messages' ? (
          <ScriptMessages
            messages={messages}
            truncated={!running && (outcome?.messagesTruncated ?? false)}
          />
        ) : result?.kind === 'documents' ? (
          <div className={styles.result}>
            <DocumentResults
              key={result.documents.documentsId}
              result={result.documents}
              view={view}
              label={t('mongo.script.result')}
            />
          </div>
        ) : result?.kind === 'text' ? (
          <pre className={styles.text} data-testid="script-text">
            {result.text}
            {result.truncated && `\n… ${t('mongo.script.truncated')}`}
          </pre>
        ) : running || failure || error ? null : (
          <p className={styles.empty}>
            {outcome ? t('mongo.script.noResult') : t('mongo.script.empty')}
          </p>
        )}
      </div>
    </>
  );
}
