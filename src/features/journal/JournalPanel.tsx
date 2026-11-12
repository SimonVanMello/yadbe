import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react';

import { confirm } from '../../app/errors/confirmStore';
import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { showError } from '../../app/errors/presentError';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, YadbeIpcError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Select, type SelectOption } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { useNow } from '../../ui/useNow';
import { qualifierOf, useConnections, useEngines } from '../connections/connectionStore';
import { JournalDetail } from './JournalDetail';
import styles from './JournalPanel.module.css';
import { entryTarget, isJournalFiltered, tableKey } from './journalModel';
import { useJournalUi } from './journalStore';
import { JournalRow } from './JournalRow';
import { JOURNAL_LOAD_MORE_MARGIN, useJournalList, useJournalTables } from './useJournal';

const SEARCH_DELAY_MS = 200;
const ROW_ESTIMATE = 56;

/**
 * The Journal view of the sidebar (F-090): every change set applied from a table tab, newest
 * first, searchable and filtered by connection and table; the selected one can be reverted.
 */
export function JournalPanel() {
  const t = useT();
  const id = useId();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const filters = useJournalUi((state) => state.filters);
  const selectedId = useJournalUi((state) => state.selectedId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const searched = useDebouncedValue(filters.text, SEARCH_DELAY_MS);
  const queryFilters = useMemo(() => ({ ...filters, text: searched }), [filters, searched]);
  const { query, entries } = useJournalList(queryFilters);
  const tables = useJournalTables(filters.connectionId);
  const connections = useConnections();
  const { engines } = useEngines();
  const byId = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections],
  );
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => entries[index]?.id ?? index,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisible = virtualItems.at(-1)?.index ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (
      hasNextPage &&
      !isFetchingNextPage &&
      lastVisible >= entries.length - JOURNAL_LOAD_MORE_MARGIN
    ) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, lastVisible, entries.length]);

  const select = (entryId: number | null) => {
    useJournalUi.getState().select(entryId);
  };

  const move = (to: 'next' | 'previous' | 'first' | 'last') => {
    if (entries.length === 0) return;
    const at = entries.findIndex((entry) => entry.id === selectedId);
    const index =
      to === 'first'
        ? 0
        : to === 'last'
          ? entries.length - 1
          : Math.min(entries.length - 1, Math.max(0, at + (to === 'next' ? 1 : -1)));
    const target = entries[index];
    if (!target) return;
    select(target.id);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') move('next');
    else if (event.key === 'ArrowUp') move('previous');
    else if (event.key === 'Home') move('first');
    else if (event.key === 'End') move('last');
    else return;
    event.preventDefault();
  };

  const connectionOptions: SelectOption<string>[] = [
    { value: '', label: t('journal.filter.allConnections') },
    ...connections.map((connection) => ({ value: connection.id, label: connection.name })),
  ];
  const tableOptions: SelectOption<string>[] = [
    { value: '', label: t('journal.filter.allTables') },
    ...(tables.data ?? [])
      .filter((item) => filters.connectionId === null || item.connectionId === filters.connectionId)
      .filter(
        (item, index, all) =>
          all.findIndex((other) => tableKey(other.table) === tableKey(item.table)) === index,
      )
      .map((item) => ({
        value: tableKey(item.table),
        // A key-value entry names a database index and a key, not a schema and a table.
        label: entryTarget(
          { family: byId.get(item.connectionId)?.family ?? 'sql', table: item.table },
          qualifierOf(engines, byId.get(item.connectionId)?.engine ?? null),
        ),
      })),
  ];

  const clear = async () => {
    const connection = filters.connectionId ? byId.get(filters.connectionId) : undefined;
    const confirmed = await confirm({
      title: t('journal.clear.title'),
      description: connection
        ? t('journal.clear.connection', { name: connection.name })
        : t('journal.clear.all'),
      confirmLabel: t('journal.clear.confirm'),
      danger: true,
      ...(connection ? { connection } : {}),
    });
    if (!confirmed) return;
    try {
      await unwrap(ipc.commands.clearChangeJournal(filters.connectionId));
    } catch (error) {
      showError(error, { title: t('journal.clear.failed') });
    }
  };

  const filtered = isJournalFiltered(filters);
  const showList = query.isSuccess;

  return (
    <section className={styles.panel} aria-label={t('journal.title')}>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('journal.title')}</h2>
        <IconButton
          icon="trash"
          size="sm"
          label={t('journal.clear')}
          onClick={() => {
            void clear();
          }}
        />
      </header>
      <div className={styles.search}>
        <Icon name="search" className={styles.searchIcon} />
        <TextInput
          className={styles.searchInput}
          data-journal-search=""
          value={filters.text}
          placeholder={t('journal.search.placeholder')}
          aria-label={t('journal.search')}
          onChange={(event) => {
            useJournalUi.getState().patchFilters({ text: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') useJournalUi.getState().patchFilters({ text: '' });
            else if (event.key === 'ArrowDown') {
              event.preventDefault();
              scrollRef.current?.focus();
              move(selectedId === null ? 'first' : 'next');
            }
          }}
        />
      </div>
      <div className={styles.filters}>
        <label className={styles.srOnly} htmlFor={`${id}-connection`}>
          {t('journal.filter.connection')}
        </label>
        <Select
          id={`${id}-connection`}
          value={filters.connectionId ?? ''}
          options={connectionOptions}
          onChange={(value) => {
            useJournalUi
              .getState()
              .patchFilters({ connectionId: value === '' ? null : value, table: null });
          }}
        />
        <label className={styles.srOnly} htmlFor={`${id}-table`}>
          {t('journal.filter.table')}
        </label>
        <Select
          id={`${id}-table`}
          value={filters.table ? tableKey(filters.table) : ''}
          options={tableOptions}
          onChange={(value) => {
            const table = tables.data?.find((item) => tableKey(item.table) === value)?.table;
            useJournalUi.getState().patchFilters({ table: table ?? null });
          }}
        />
      </div>

      <div
        ref={scrollRef}
        className={styles.list}
        role="listbox"
        tabIndex={0}
        aria-label={t('journal.list')}
        aria-activedescendant={
          selectedId === null ? undefined : `journal-row-${String(selectedId)}`
        }
        aria-busy={query.isFetching}
        onKeyDown={onKeyDown}
      >
        {query.isPending && (
          <div className={styles.state}>
            <Spinner />
          </div>
        )}
        {query.isError && (
          <div className={styles.error}>
            {query.error instanceof YadbeIpcError ? (
              <ErrorPanel
                compact
                title={t('journal.loadFailed')}
                error={query.error.error}
                context={{
                  retry: () => {
                    void query.refetch();
                  },
                }}
              />
            ) : (
              <p className={styles.empty}>{t('journal.loadFailed')}</p>
            )}
          </div>
        )}
        {showList && entries.length === 0 && (
          <div className={styles.state}>
            <p className={styles.empty}>
              {filtered ? t('journal.emptyFiltered') : t('journal.empty')}
            </p>
            {filtered && (
              <Button
                size="sm"
                onClick={() => {
                  useJournalUi.getState().resetFilters();
                }}
              >
                {t('journal.filters.reset')}
              </Button>
            )}
          </div>
        )}
        {showList && entries.length > 0 && (
          <div className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtual) => {
              const entry = entries[virtual.index];
              if (!entry) return null;
              return (
                <JournalRow
                  key={entry.id}
                  entry={entry}
                  connection={byId.get(entry.connectionId)}
                  selected={entry.id === selectedId}
                  now={now}
                  locale={locale}
                  index={virtual.index}
                  offset={virtual.start}
                  measureRef={virtualizer.measureElement}
                  domId={`journal-row-${String(entry.id)}`}
                  onSelect={() => {
                    select(entry.id);
                  }}
                />
              );
            })}
          </div>
        )}
        {isFetchingNextPage && (
          <div className={styles.more} role="status" aria-label={t('journal.loadingMore')}>
            <Spinner />
          </div>
        )}
      </div>
      {selected && <JournalDetail key={selected.id} entry={selected} />}
    </section>
  );
}
