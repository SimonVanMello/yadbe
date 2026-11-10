import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';

import { useLayoutStore } from '../../app/layout/layoutStore';
import { useI18nStore } from '../../i18n/i18n';
import { formatDuration } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { toast } from '../../ui/toastStore';
import { localize } from '../../app/errors/presentError';
import styles from './StatementLogPanel.module.css';
import { LogEntryRow } from './LogEntryRow';
import {
  clearStatementLog,
  useStatementLog,
  visibleEntries,
  type LogFilter,
} from './statementLogStore';

const ROW_HEIGHT_ESTIMATE = 26;

/** Bottom panel listing what yadbe ran on its own, newest first (F-124, SPEC §1.6). */
export function StatementLogPanel() {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const entries = useStatementLog((state) => state.entries);
  const filter = useStatementLog((state) => state.filter);
  const selectedId = useStatementLog((state) => state.selectedId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => visibleEntries(entries, filter), [entries, filter]);
  const selected = visible.find((entry) => entry.id === selectedId) ?? null;
  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 12,
  });

  const filterOptions: { value: LogFilter; label: string }[] = [
    { value: 'all', label: t('log.filter.all') },
    { value: 'errors', label: t('log.filter.errors') },
  ];

  return (
    <section className={styles.panel} aria-label={t('log.title')}>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('log.title')}</h2>
        <span className={styles.count}>{t('log.count', { count: entries.length })}</span>
        <SegmentedControl
          label={t('log.filter')}
          value={filter}
          options={filterOptions}
          onChange={(value) => {
            useStatementLog.getState().setFilter(value);
          }}
        />
        <span className={styles.spacer} />
        <Button
          size="sm"
          variant="ghost"
          disabled={entries.length === 0}
          onClick={() => {
            void clearStatementLog();
          }}
        >
          {t('log.clear')}
        </Button>
        <IconButton
          icon="close"
          size="sm"
          label={t('log.close')}
          onClick={() => {
            useLayoutStore.getState().setCollapsed('bottom', true);
          }}
        />
      </header>
      <div className={styles.body}>
        <div ref={scrollRef} className={styles.list} role="listbox" aria-label={t('log.title')}>
          {visible.length === 0 ? (
            <p className={styles.empty}>
              {entries.length === 0 ? t('log.empty') : t('log.emptyFiltered')}
            </p>
          ) : (
            <div className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = visible[item.index];
                if (!entry) return null;
                return (
                  <LogEntryRow
                    key={entry.id}
                    entry={entry}
                    selected={entry.id === selectedId}
                    offset={item.start}
                    height={item.size}
                    locale={locale}
                    onSelect={() => {
                      useStatementLog.getState().select(entry.id);
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
        {selected && (
          <aside className={styles.detail} aria-label={t('log.detail')}>
            <div className={styles.detailHeader}>
              <span>
                {selected.connectionName || t('log.noConnection')}
                {selected.durationMs !== null &&
                  ` · ${formatDuration(selected.durationMs, locale)}`}
              </span>
              <IconButton
                icon="copy"
                size="sm"
                label={t('log.copy')}
                onClick={() => {
                  void navigator.clipboard.writeText(selected.sql).then(() => {
                    toast({ variant: 'success', title: t('log.copied') });
                  });
                }}
              />
            </div>
            <pre className={styles.sql}>{selected.sql}</pre>
            {selected.outcome.kind === 'error' && (
              <div className={styles.error} role="alert">
                <Icon name="error" />
                <div>
                  <p>{localize(selected.outcome.error.message)}</p>
                  {selected.outcome.error.detail && <p>{selected.outcome.error.detail}</p>}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
