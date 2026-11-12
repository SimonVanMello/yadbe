import { useEffect, useRef } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import type { ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { useShortcutOf } from '../../app/useShortcutOf';
import { connectTo } from '../connections/connectionActions';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { QuerySplit } from '../query/QuerySplit';
import { useQueryTabStore } from '../query/queryTabStore';
import { useQueryUiStore } from '../query/queryUiStore';
import { ConsoleEditor } from './ConsoleEditor';
import styles from './KvConsole.module.css';
import { useKvConsole } from './kvConsoleStore';
import { ReplyView } from './ReplyView';

/**
 * The query tab of a key-value connection: a console where each line is a command as in
 * `redis-cli`, and under it the reply of each command of the last run, in order.
 */
export function KvConsole({ tab, connection }: { tab: ShellTab; connection: ConnectionSummary }) {
  const t = useT();
  const shortcutOf = useShortcutOf();
  const ratio = useQueryUiStore((state) => state.resultsRatio);
  const container = useRef<HTMLDivElement>(null);
  const output = useRef<HTMLDivElement>(null);
  const state = useConnectionState(connection.id);
  const run = useKvConsole(tab.id);

  useEffect(() => {
    useQueryTabStore.getState().ensure(tab.id);
  }, [tab.id]);

  useEffect(() => {
    output.current?.scrollTo({ top: 0 });
  }, [run.runId]);

  return (
    <div ref={container} className={styles.view}>
      {state !== 'connected' && (
        <div className={styles.notice} role="status">
          <Icon name="info" />
          <span>{t('keyValue.console.notConnected', { name: connection.name })}</span>
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
      <div className={styles.editorPane}>
        <ConsoleEditor key={tab.id} tabId={tab.id} />
      </div>
      <QuerySplit container={container} />
      <div
        ref={output}
        className={styles.output}
        style={{ flexBasis: `${String(ratio * 100)}%` }}
        aria-label={t('keyValue.console.output')}
        aria-busy={run.running}
      >
        {run.running && (
          <div className={styles.running}>
            <Spinner /> {t('keyValue.console.running')}
          </div>
        )}
        {run.error && <ErrorPanel compact title={t('keyValue.console.failed')} error={run.error} />}
        {!run.running && run.entries.length === 0 && !run.error && (
          <p className={styles.hint}>
            <Kbd shortcut={shortcutOf('query.run')} /> {t('keyValue.console.hintRun')}{' '}
            <Kbd shortcut={shortcutOf('query.runStatement')} /> {t('keyValue.console.hintLine')}
          </p>
        )}
        <ol className={styles.entries}>
          {run.entries.map((entry, index) => (
            <li
              key={`${String(run.runId)}-${String(index)}`}
              className={styles.entry}
              data-failed={entry.error !== null || undefined}
            >
              <div className={styles.entryHead}>
                <span className={styles.prompt}>db{entry.database}&gt;</span>
                <code className={styles.command}>{entry.command}</code>
                <span className={styles.meta}>
                  {t('keyValue.console.line', { line: entry.line + 1 })} ·{' '}
                  {t('keyValue.console.duration', { ms: (entry.durationMs ?? 0).toFixed(1) })}
                </span>
              </div>
              {entry.error ? (
                <ErrorPanel
                  compact
                  title={t('keyValue.console.commandFailed')}
                  error={entry.error}
                />
              ) : entry.reply ? (
                <ReplyView reply={entry.reply} label={entry.command} />
              ) : null}
            </li>
          ))}
        </ol>
        {run.skipped > 0 && (
          <p className={styles.skipped}>{t('keyValue.console.skipped', { count: run.skipped })}</p>
        )}
      </div>
    </div>
  );
}
