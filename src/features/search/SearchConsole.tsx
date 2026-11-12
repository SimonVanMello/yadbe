import { useEffect, useRef } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import type { ShellTab } from '../../app/tabs/tabsStore';
import { useShortcutOf } from '../../app/useShortcutOf';
import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ConsoleResponse } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { connectTo } from '../connections/connectionActions';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { QuerySplit } from '../query/QuerySplit';
import { useQueryTabStore } from '../query/queryTabStore';
import { useQueryUiStore } from '../query/queryUiStore';
import { ResponseBody } from './ResponseBody';
import styles from './SearchConsole.module.css';
import { SearchConsoleEditor } from './SearchConsoleEditor';
import { useSearchConsole, useSearchConsoleStore } from './searchConsoleStore';

function statusTone(response: ConsoleResponse): 'ok' | 'warn' | 'error' {
  if (response.status === null || response.status >= 500) return 'error';
  if (response.status >= 400) return 'warn';
  return 'ok';
}

/**
 * The query tab of a search connection: a console in Kibana's syntax (`METHOD /path`, then a
 * JSON body; several requests per tab), and under it the answers of the last run, one at a
 * time: status, time taken, shards, then the hits, table or JSON of the answer.
 */
export function SearchConsole({
  tab,
  connection,
}: {
  tab: ShellTab;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const shortcutOf = useShortcutOf();
  const ratio = useQueryUiStore((state) => state.resultsRatio);
  const container = useRef<HTMLDivElement>(null);
  const state = useConnectionState(connection.id);
  const run = useSearchConsole(tab.id);
  const response = run.responses[run.selected] ?? null;

  useEffect(() => {
    useQueryTabStore.getState().ensure(tab.id);
  }, [tab.id]);

  return (
    <div ref={container} className={styles.view}>
      {state !== 'connected' && (
        <div className={styles.notice} role="status">
          <Icon name="info" />
          <span>{t('search.console.notConnected', { name: connection.name })}</span>
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
        <SearchConsoleEditor key={tab.id} tabId={tab.id} />
      </div>
      <QuerySplit container={container} />
      <div
        className={styles.output}
        style={{ flexBasis: `${String(ratio * 100)}%` }}
        aria-label={t('search.console.output')}
        aria-busy={run.running}
      >
        {run.running && (
          <div className={styles.running}>
            <Spinner /> {t('search.console.running')}
          </div>
        )}
        {run.error && <ErrorPanel compact title={t('search.console.failed')} error={run.error} />}
        {run.failure && (
          <ErrorPanel
            compact
            title={t('search.console.notRequests', { line: run.failure.line + 1 })}
            error={run.failure.error}
          />
        )}
        {!run.running && run.responses.length === 0 && !run.error && !run.failure && (
          <p className={styles.hint}>
            <Kbd shortcut={shortcutOf('query.run')} /> {t('search.console.hintRun')}
          </p>
        )}
        {run.responses.length > 0 && (
          <div className={styles.answers} role="tablist" aria-label={t('search.console.answers')}>
            {run.responses.map((entry, index) => (
              <button
                key={`${String(run.runId)}-${String(index)}`}
                type="button"
                role="tab"
                aria-selected={index === run.selected}
                className={styles.answer}
                data-tone={statusTone(entry)}
                onClick={() => {
                  useSearchConsoleStore.getState().update(tab.id, { selected: index });
                }}
              >
                <span className={styles.status}>{entry.status ?? '—'}</span>
                <span className={styles.request}>
                  {entry.method} {entry.path}
                </span>
              </button>
            ))}
            {run.skipped > 0 && (
              <span className={styles.skipped}>
                {t('search.console.skipped', { count: run.skipped })}
              </span>
            )}
          </div>
        )}
        {response && (
          <div className={styles.response} data-testid="search-response">
            <div className={styles.responseHead}>
              <span className={styles.status} data-tone={statusTone(response)}>
                {response.status === null
                  ? t('search.console.notSent')
                  : t('search.console.status', { status: response.status })}
              </span>
              <code className={styles.requestLine}>
                {response.method} {response.path}
              </code>
              <span className={styles.meta}>
                {[
                  t('search.console.line', { line: response.line + 1 }),
                  response.tookMs !== null &&
                    t('search.took', { ms: formatNumber(locale, response.tookMs) }),
                  response.shards &&
                    t('search.console.shards', {
                      successful: response.shards.successful ?? 0,
                      total: response.shards.total ?? 0,
                      failed: response.shards.failed ?? 0,
                    }),
                  response.timedOut && t('search.console.timedOut'),
                  t('search.console.duration', {
                    ms: formatNumber(locale, Math.round(response.durationMs ?? 0)),
                  }),
                  response.body.kind === 'json' &&
                    response.body.total !== null &&
                    response.body.total.value !== null &&
                    t(response.body.total.exact ? 'search.count.exact' : 'search.count.atLeast', {
                      count: formatNumber(locale, response.body.total.value),
                    }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            {response.error && (
              <ErrorPanel
                compact
                title={
                  response.errorPosition
                    ? t('search.console.errorAt', {
                        line: response.errorPosition.line,
                        column: response.errorPosition.column,
                      })
                    : t('search.console.requestFailed')
                }
                error={response.error}
              />
            )}
            <ResponseBody
              response={response}
              view={run.view}
              onView={(view) => {
                useSearchConsoleStore.getState().update(tab.id, { view });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
