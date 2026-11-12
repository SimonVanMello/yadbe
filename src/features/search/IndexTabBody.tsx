import { useEffect, useId, type KeyboardEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { IndexQueryMode, ObjectRef } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { Tooltip } from '../../ui/Tooltip';
import { connectTo } from '../connections/connectionActions';
import { ConnectionChip } from '../connections/ConnectionChip';
import {
  useConnection,
  useConnectionList,
  useConnectionState,
} from '../connections/connectionStore';
import { HitsResults } from './HitsResults';
import {
  applyIndexQuery,
  cancelIndex,
  countIndexExactly,
  fetchIndexPage,
  openIndex,
  setIndexDraft,
  setIndexPageSize,
} from './indexActions';
import { INDEX_PAGE_SIZES, useIndexStore, useIndexTab, type HitsView } from './indexStore';
import styles from './IndexTabBody.module.css';

/**
 * Body of an index tab (a table tab of a search connection): a query string or a Query DSL
 * object, `_source` filtering, a sort on a sortable field, pages on a point in time (or by
 * `from` / `size` up to the result window, said so), the count as the server gives it (exact,
 * or a lower bound) and the exact one on request, the hits as a grid or as documents. A
 * restored tab does not connect by itself.
 */
export function IndexTabBody({ tab, table }: { tab: ShellTab; table: ObjectRef }) {
  const t = useT();
  const id = useId();
  const locale = useI18nStore((state) => state.locale);
  const list = useConnectionList();
  const connection = useConnection(tab.connectionId);
  const state = useConnectionState(tab.connectionId);
  const index = useIndexTab(tab.id);
  const connected = state === 'connected';
  const { phase } = index;

  useEffect(() => {
    if (!connected) {
      if (useIndexStore.getState().tabs[tab.id]?.phase === 'ready') {
        useIndexStore.getState().patch(tab.id, { phase: 'idle' });
      }
      return;
    }
    if (phase === 'idle') void openIndex(tab.id);
  }, [connected, phase, tab.id]);

  if (!connection) {
    if (list.isPending) {
      return (
        <div className={styles.placeholder}>
          <Spinner />
        </div>
      );
    }
    return (
      <div className={styles.placeholder}>
        <Icon name="warning" size="lg" />
        <p className={styles.title}>{t('tab.body.missing')}</p>
        <Button
          onClick={() => {
            useTabsStore.getState().closeTab(tab.id);
          }}
        >
          {t('tab.menu.close')}
        </Button>
      </div>
    );
  }

  if (!connected && phase !== 'ready') {
    const busy = state === 'connecting' || state === 'reconnecting';
    return (
      <div className={styles.placeholder}>
        <ConnectionChip connection={connection} state={state} size="md" />
        <p className={styles.title}>{table.name}</p>
        <p className={styles.text}>{t('tableData.connectFirst')}</p>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            void connectTo(connection);
          }}
        >
          {busy ? <Spinner /> : <Icon name="database" />}
          {t('tableData.connect')}
        </Button>
      </div>
    );
  }

  const { info, page, draft, loading, counting, exactCount, error, view } = index;
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void applyIndexQuery(tab.id);
    }
  };
  const first = page ? page.page * index.pageSize : 0;
  const shown = page?.documents.count ?? 0;
  const sortable = (info?.details.fields ?? []).filter((field) => field.sortable);
  const total = page?.total ?? null;
  const countText =
    exactCount !== null
      ? t('search.count.exact', { count: formatNumber(locale, exactCount) })
      : total !== null && total.value !== null
        ? t(total.exact ? 'search.count.exact' : 'search.count.atLeast', {
            count: formatNumber(locale, total.value),
          })
        : null;
  const queryError = error?.code === 'invalidArgument' || error?.code === 'queryFailed';

  return (
    <div className={styles.view} data-testid="index-tab">
      <div className={styles.query} role="search" aria-label={t('search.index.query')}>
        <SegmentedControl<IndexQueryMode>
          label={t('search.index.mode')}
          value={draft.mode}
          options={[
            { value: 'queryString', label: t('search.index.mode.queryString') },
            { value: 'dsl', label: t('search.index.mode.dsl') },
          ]}
          onChange={(mode) => {
            setIndexDraft(tab.id, { mode });
          }}
        />
        <label className={styles.queryField} htmlFor={`${id}-query`}>
          <span className={styles.fieldLabel}>
            {draft.mode === 'dsl' ? t('search.index.dsl') : t('search.index.queryString')}
          </span>
          <TextInput
            id={`${id}-query`}
            data-field="query"
            mono
            value={draft.text}
            placeholder={
              draft.mode === 'dsl'
                ? '{ "match": { "status": "paid" } }'
                : 'status:paid AND total:>100'
            }
            spellCheck={false}
            invalid={queryError}
            onChange={(event) => {
              setIndexDraft(tab.id, { text: event.target.value });
            }}
            onKeyDown={onEnter}
          />
        </label>
        <label className={styles.optionField} htmlFor={`${id}-source`}>
          <span className={styles.fieldLabel}>{t('search.index.source')}</span>
          <TextInput
            id={`${id}-source`}
            data-field="source"
            mono
            value={draft.source}
            placeholder="customer.*, -notes"
            spellCheck={false}
            onChange={(event) => {
              setIndexDraft(tab.id, { source: event.target.value });
            }}
            onKeyDown={onEnter}
          />
        </label>
        <label className={styles.optionField} htmlFor={`${id}-sort`}>
          <span className={styles.fieldLabel}>{t('search.index.sort')}</span>
          <span className={styles.sort}>
            <Select
              id={`${id}-sort`}
              data-field="sort"
              value={draft.sortField}
              options={[
                { value: '', label: t('search.index.sort.none') },
                ...sortable.map((field) => ({ value: field.path, label: field.path })),
              ]}
              onChange={(sortField) => {
                setIndexDraft(tab.id, { sortField });
              }}
            />
            <IconButton
              icon={draft.descending ? 'arrowDown' : 'arrowUp'}
              size="sm"
              label={draft.descending ? t('search.index.sort.desc') : t('search.index.sort.asc')}
              disabled={draft.sortField === ''}
              onClick={() => {
                setIndexDraft(tab.id, { descending: !draft.descending });
              }}
            />
          </span>
        </label>
        <Button
          variant="primary"
          size="sm"
          disabled={loading}
          onClick={() => {
            void applyIndexQuery(tab.id);
          }}
        >
          {loading ? <Spinner /> : <Icon name="play" />}
          {t('search.index.apply')}
        </Button>
      </div>
      <div className={styles.bar}>
        <SegmentedControl<HitsView>
          label={t('search.view.label')}
          value={view}
          options={[
            { value: 'grid', label: t('search.view.grid') },
            { value: 'documents', label: t('search.view.documents') },
          ]}
          onChange={(next) => {
            useIndexStore.getState().patch(tab.id, { view: next });
          }}
        />
        <span className={styles.separator} aria-hidden="true" />
        <IconButton
          icon="chevronLeft"
          size="sm"
          label={t('search.page.previous')}
          disabled={loading || !page || page.page === 0}
          onClick={() => {
            if (page) void fetchIndexPage(tab.id, page.page - 1);
          }}
        />
        <span className={styles.range} data-testid="index-range">
          {shown === 0
            ? t('search.page.none')
            : t('search.page.range', {
                from: formatNumber(locale, first + 1),
                to: formatNumber(locale, first + shown),
              })}
        </span>
        <IconButton
          icon="chevronRight"
          size="sm"
          label={t('search.page.next')}
          disabled={loading || !page?.hasMore}
          onClick={() => {
            if (page) void fetchIndexPage(tab.id, page.page + 1);
          }}
        />
        <Select
          className={styles.pageSize}
          aria-label={t('search.page.size')}
          value={String(index.pageSize)}
          options={INDEX_PAGE_SIZES.map((size) => ({
            value: String(size),
            label: t('search.page.perPage', { count: formatNumber(locale, size) }),
          }))}
          onChange={(size) => {
            void setIndexPageSize(tab.id, Number(size));
          }}
        />
        <span className={styles.separator} aria-hidden="true" />
        <span className={styles.count} data-testid="index-count">
          {countText}
        </span>
        {counting ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              cancelIndex(tab.id);
            }}
          >
            <Spinner />
            {t('search.count.cancel')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={phase !== 'ready' || (total?.exact ?? false) || exactCount !== null}
            onClick={() => {
              void countIndexExactly(tab.id);
            }}
          >
            {t('search.count.button')}
          </Button>
        )}
        <span className={styles.spacer} />
        {page && (
          <Tooltip content={<pre className={styles.request}>{page.request}</pre>}>
            <span className={styles.paging} data-testid="index-paging">
              {page.paging === 'pointInTime'
                ? t('search.page.pit')
                : t('search.page.window', {
                    window: formatNumber(locale, page.window ?? 10_000),
                  })}
              {page.tookMs !== null &&
                ` · ${t('search.took', { ms: formatNumber(locale, page.tookMs) })}`}
            </span>
          </Tooltip>
        )}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          <Icon name="warning" />
          <span>{localize(error.message)}</span>
          {error.detail && <code className={styles.detail}>{error.detail}</code>}
        </div>
      )}
      <div className={styles.results}>
        {loading && !page ? (
          <div className={styles.placeholder}>
            <Spinner />
          </div>
        ) : page ? (
          <HitsResults
            result={page.documents}
            view={view}
            label={t('search.index.results', { name: table.name })}
          />
        ) : null}
        {loading && page && (
          <div className={styles.busy}>
            <Spinner />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                cancelIndex(tab.id);
              }}
            >
              {t('search.cancel')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
