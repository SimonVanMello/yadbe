import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YadbeIpcError, type EfMigration, type ObjectRef } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import type { ConnectionSummary } from '../connections/model';
import { tableLabel } from '../table-data/tableNames';
import styles from './MigrationsView.module.css';
import { buildTimeline, dayLabel, monthLabel, spanOf, type TimelineRow } from './migrationsModel';
import { useMigrations } from './useMigrations';

/**
 * The migrations of an EF Core history table as a timeline (F-143): newest first, a heading per
 * month, each migration with its name, its id, when it was created and with which EF Core
 * version it was applied. The history says what was applied, not what is still pending.
 */
export function MigrationsView({
  connection,
  table,
}: {
  connection: ConnectionSummary;
  table: ObjectRef;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const history = useMigrations(connection.id, table);
  const scrollRef = useRef<HTMLDivElement>(null);
  const migrations = history.data?.migrations;
  const rows = useMemo(() => (migrations ? buildTimeline(migrations) : []), [migrations]);
  const span = useMemo(() => (migrations ? spanOf(migrations) : null), [migrations]);
  const failure = history.error instanceof YadbeIpcError ? history.error.error : null;

  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  return (
    <div className={styles.body}>
      <header className={styles.strip}>
        <Icon name="timeline" />
        <h2 className={styles.title}>{t('migrations.title')}</h2>
        <code className={styles.table}>{tableLabel(table)}</code>
        {migrations && (
          <span className={styles.summary} role="status">
            {t('migrations.summary', { count: migrations.length })}
            {span &&
              ` · ${t('migrations.span', { from: dayLabel(span.from, locale), to: dayLabel(span.to, locale) })}`}
          </span>
        )}
        <span className={styles.spacer} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            useTabsStore.getState().openTableTab(connection.id, table);
          }}
        >
          <Icon name="table" />
          {t('migrations.openTable')}
        </Button>
        <IconButton
          icon="retry"
          label={t('migrations.refresh')}
          disabled={history.isFetching}
          aria-busy={history.isFetching}
          onClick={() => {
            void history.refetch();
          }}
        />
      </header>

      {history.isPending && (
        <div className={styles.state}>
          <Spinner />
        </div>
      )}
      {history.isError && (
        <div className={styles.state}>
          {failure ? (
            <ErrorPanel
              title={t('migrations.failed')}
              error={failure}
              context={{
                connectionId: connection.id,
                retry: () => {
                  void history.refetch();
                },
              }}
            />
          ) : (
            <p>{t('migrations.failed')}</p>
          )}
        </div>
      )}
      {migrations && (
        <>
          <p className={styles.note}>
            <Icon name="info" />
            {t('migrations.note')}
          </p>
          {migrations.length === 0 ? (
            <div className={styles.state}>
              <p>{t('migrations.empty')}</p>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className={styles.scroll}
              role="list"
              tabIndex={0}
              aria-label={t('migrations.list')}
            >
              <div className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((virtual) => {
                  const row = rows[virtual.index];
                  if (!row) return null;
                  return (
                    <div
                      key={virtual.key}
                      ref={virtualizer.measureElement}
                      data-index={virtual.index}
                      className={styles.row}
                      style={{ transform: `translateY(${String(virtual.start)}px)` }}
                    >
                      <TimelineEntry row={row} locale={locale} />
                    </div>
                  );
                })}
              </div>
              {history.data?.truncated && (
                <p className={styles.truncated}>
                  {t('migrations.truncated', { count: migrations.length })}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TimelineEntry({ row, locale }: { row: TimelineRow; locale: string }) {
  const t = useT();
  if (row.type === 'month') {
    return (
      <div className={styles.month} role="presentation">
        <span className={styles.monthName}>
          {monthLabel(row.key, locale) ?? t('migrations.noTimestamp')}
        </span>
        <span className={styles.monthCount}>{row.count}</span>
      </div>
    );
  }
  return <MigrationEntry migration={row.migration} locale={locale} />;
}

function MigrationEntry({ migration, locale }: { migration: EfMigration; locale: string }) {
  const t = useT();
  const time = migration.timestamp
    ? `${dayLabel(migration.timestamp.slice(0, 10), locale)} ${migration.timestamp.slice(11)}`
    : t('migrations.noTimestamp');
  return (
    <div className={styles.entry} role="listitem">
      <span className={styles.rail} aria-hidden="true">
        <span className={styles.dot} />
      </span>
      <time className={styles.time} dateTime={migration.timestamp?.replace(' ', 'T')}>
        {time}
      </time>
      <span className={styles.what}>
        <span className={styles.name}>{migration.name}</span>
        <code className={styles.id}>{migration.id}</code>
      </span>
      <span className={styles.version} data-known={migration.productVersion !== null}>
        {migration.productVersion
          ? t('migrations.version', { version: migration.productVersion })
          : t('migrations.versionUnknown')}
      </span>
    </div>
  );
}
