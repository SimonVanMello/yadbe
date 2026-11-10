import type { KeyboardEvent } from 'react';

import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { ResultGrid } from '../grid/ResultGrid';
import { shortcutOf } from '../../app/actions';
import {
  effectiveSelection,
  isWorking,
  summarizeExecution,
  type ResultsSelection,
  type TabExecution,
} from './executionModel';
import { useElapsedMs, useExecutionStore, useTabExecution } from './executionStore';
import { formatDuration } from './format';
import { MessagesPanel } from './MessagesPanel';
import styles from './ResultsArea.module.css';

const tabDomId = (tabId: string, key: string) => `results-${tabId}-${key}`;

/**
 * Results area of a query tab (F-061): one sub-tab per result set ("Result N"), then
 * "Messages", and a summary of the run on the right (live elapsed time while it runs, F-042).
 */
export function ResultsArea({ tabId }: { tabId: string }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const execution = useTabExecution(tabId);
  const picked = useExecutionStore((state) => state.selections[tabId]);
  const selection = effectiveSelection(picked, execution);
  const select = (next: ResultsSelection) => {
    useExecutionStore.getState().select(tabId, next);
  };

  const tabs: { key: string; label: string; detail?: string; value: ResultsSelection }[] = [
    ...execution.results.map((result, index) => ({
      key: `result-${String(result.resultId)}`,
      label: t('query.results.result', { number: index + 1 }),
      detail: `· ${formatNumber(locale, result.rowCount)}${result.status === 'paused' || result.truncated ? '+' : ''}`,
      value: { kind: 'result', resultId: result.resultId } as const,
    })),
    {
      key: 'messages',
      label: t('query.results.messages'),
      value: { kind: 'messages' } as const,
    },
  ];
  const selectedKey =
    selection.kind === 'messages' ? 'messages' : `result-${String(selection.resultId)}`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.findIndex((tab) => tab.key === selectedKey);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    if (!next) return;
    event.preventDefault();
    select(next.value);
    document.getElementById(tabDomId(tabId, next.key))?.focus();
  };

  const selectedResult =
    selection.kind === 'result'
      ? execution.results.find((result) => result.resultId === selection.resultId)
      : undefined;

  return (
    <section className={styles.area} aria-label={t('query.results.label')}>
      <div className={styles.header}>
        <div
          role="tablist"
          aria-label={t('query.results.tabs')}
          className={styles.tabs}
          onKeyDown={onKeyDown}
        >
          {tabs.map((tab) => {
            const selected = tab.key === selectedKey;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={tabDomId(tabId, tab.key)}
                aria-selected={selected}
                aria-controls={tabDomId(tabId, 'panel')}
                tabIndex={selected ? 0 : -1}
                className={styles.tab}
                onClick={() => {
                  select(tab.value);
                }}
              >
                {tab.label}
                {tab.detail !== undefined && <span className={styles.count}>{tab.detail}</span>}
                {tab.key === 'messages' && summarizeExecution(execution).errors > 0 && (
                  <span
                    className={styles.errorDot}
                    role="img"
                    aria-label={t('query.results.hasErrors')}
                  />
                )}
              </button>
            );
          })}
        </div>
        <RunSummary tabId={tabId} execution={execution} />
      </div>
      <div
        role="tabpanel"
        id={tabDomId(tabId, 'panel')}
        aria-labelledby={tabDomId(tabId, selectedKey)}
        className={styles.panel}
      >
        {execution.status === 'idle' ? (
          <EmptyResults />
        ) : selection.kind === 'messages' || !selectedResult ? (
          <MessagesPanel tabId={tabId} execution={execution} />
        ) : (
          <ResultGrid
            resultId={selectedResult.resultId}
            summary={selectedResult}
            label={t('query.results.result', {
              number: execution.results.indexOf(selectedResult) + 1,
            })}
          />
        )}
      </div>
    </section>
  );
}

function EmptyResults() {
  const t = useT();
  return (
    <div className={styles.empty}>
      <p>{t('query.results.empty')}</p>
      <p className={styles.hints}>
        <span>
          <Kbd shortcut={shortcutOf('query.run')} /> {t('query.results.hintRun')}
        </span>
        <span>
          <Kbd shortcut={shortcutOf('query.runStatement')} /> {t('query.results.hintStatement')}
        </span>
      </p>
    </div>
  );
}

/** Status of the run on the right of the sub-tabs: progress while it runs, outcome after. */
function RunSummary({ tabId, execution }: { tabId: string; execution: TabExecution }) {
  const t = useT();
  const elapsed = useElapsedMs(tabId);
  const { status } = execution;
  if (status === 'idle') return null;
  const time = formatDuration(elapsed);
  const counts = summarizeExecution(execution);
  const rows = execution.results.reduce((sum, result) => sum + result.rowCount, 0);

  let text: string;
  switch (status) {
    case 'connecting':
      text = t('query.status.connecting', { time });
      break;
    case 'running':
      text = t('query.status.running', {
        current: (execution.currentStatement ?? 0) + 1,
        total: counts.statements,
        time,
      });
      break;
    case 'paused':
      text = t('query.status.paused', { time });
      break;
    case 'succeeded': {
      const statements = t('query.status.statementCount', { count: counts.statements });
      text =
        execution.results.length === 0
          ? t('query.status.succeededNoRows', { statements, time })
          : t('query.status.succeeded', {
              statements,
              rows: t('query.result.rows', { count: rows }),
              time,
            });
      break;
    }
    case 'cancelled':
      text = t('query.status.cancelled', { time });
      break;
    case 'failed':
      text = t('query.status.failed', { time });
      break;
  }
  return (
    <div className={styles.summary} data-status={status} role="status" aria-live="polite">
      {isWorking(status) && <Spinner />}
      <span data-testid="run-status">{text}</span>
    </div>
  );
}
