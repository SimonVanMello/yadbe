import { shortcutOf } from '../../app/actions';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { cancelTableWork, countRows, goToPage, refreshTable, setPageSize } from './tableActions';
import { useTableSession } from './tableSessionStore';
import styles from './TableView.module.css';
import { PAGE_SIZES, useTableTabState } from './tableTabStore';
import { useShownAfter } from './useShownAfter';

/** A page read is said to run once it takes this long (SPEC §6: progress after 150 ms). */
const PROGRESS_AFTER_MS = 150;

/**
 * The strip above a table's rows (F-080): pages, page size, the row count (an estimate first,
 * exact on demand and cancellable), refresh, and what is running.
 */
export function TableStrip({ tabId }: { tabId: string }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const session = useTableSession(tabId);
  const { pageSize } = useTableTabState(tabId);
  const { page, offset, count, counting, loadingSince, stale } = session;
  const loading = loadingSince !== null;
  const slow = useShownAfter(loadingSince, PROGRESS_AFTER_MS);
  const number = new Intl.NumberFormat(locale);
  const first = page && page.rowCount > 0 ? offset + 1 : offset;
  const last = offset + (page?.rowCount ?? 0);
  const sizes = PAGE_SIZES.includes(pageSize as (typeof PAGE_SIZES)[number])
    ? PAGE_SIZES
    : [...PAGE_SIZES, pageSize].sort((a, b) => a - b);

  return (
    <div className={styles.strip} role="toolbar" aria-label={t('tableData.strip.label')}>
      <span className={styles.group}>
        <IconButton
          icon="chevronLeft"
          size="sm"
          label={t('action.table.previousPage')}
          shortcut={shortcutOf('table.previousPage')}
          disabled={offset === 0 || loading}
          onClick={() => {
            void goToPage(tabId, 'previous');
          }}
        />
        <span className={styles.range} data-testid="table-range">
          {page
            ? t('tableData.page.range', { first: number.format(first), last: number.format(last) })
            : '—'}
        </span>
        <IconButton
          icon="chevronRight"
          size="sm"
          label={t('action.table.nextPage')}
          shortcut={shortcutOf('table.nextPage')}
          disabled={!page?.hasMore || loading}
          onClick={() => {
            void goToPage(tabId, 'next');
          }}
        />
        {offset > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => {
              void goToPage(tabId, 'first');
            }}
          >
            {t('tableData.page.first')}
          </Button>
        )}
      </span>
      <Select<string>
        className={styles.pageSize}
        aria-label={t('tableData.page.size')}
        value={String(pageSize)}
        options={sizes.map((size) => ({
          value: String(size),
          label: t('tableData.page.sizeOption', { count: size }),
        }))}
        onChange={(value) => {
          void setPageSize(tabId, Number(value));
        }}
      />
      <span className={styles.separator} aria-hidden="true" />
      <span className={styles.count} data-testid="table-count">
        {count === null || count.count === null ? (
          <span className={styles.muted}>{t('tableData.count.unknown')}</span>
        ) : count.mode === 'exact' ? (
          t('tableData.count.exact', { count: count.count })
        ) : (
          <span title={count.filtered ? undefined : t('tableData.count.unfiltered')}>
            {t(count.filtered ? 'tableData.count.estimate' : 'tableData.count.estimateTable', {
              count: count.count,
            })}
          </span>
        )}
        {counting ? (
          <>
            <Spinner />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                cancelTableWork(tabId);
              }}
            >
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          count?.mode !== 'exact' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => {
                void countRows(tabId, 'exact');
              }}
            >
              {t('tableData.count.exactButton')}
            </Button>
          )
        )}
      </span>
      {slow && (
        <span className={styles.loading} role="status">
          <Spinner />
          {t('tableData.page.loading')}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              cancelTableWork(tabId);
            }}
          >
            {t('common.cancel')}
          </Button>
        </span>
      )}
      <span className={styles.spacer} />
      {stale && (
        <span className={styles.stale} role="status">
          <Icon name="info" />
          {t('tableData.stale')}
        </span>
      )}
      <IconButton
        icon="retry"
        size="sm"
        label={t('action.table.refresh')}
        shortcut={shortcutOf('table.refresh')}
        disabled={loading}
        onClick={() => {
          void refreshTable(tabId);
        }}
      />
    </div>
  );
}
