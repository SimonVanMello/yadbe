import { useQuery } from '@tanstack/react-query';

import { useT } from '../../i18n/useT';
import { ipc, unwrap, type ResultSummary } from '../../ipc';
import { Button } from '../../ui/Button';
import styles from './ResultPlaceholder.module.css';

/** Rows the placeholder shows: the real grid (M1-5) virtualizes, this one only peeks. */
const PREVIEW_ROWS = 50;

interface ResultPlaceholderProps {
  resultId: number;
  summary: ResultSummary;
}

/**
 * Stand-in for the result grid, with the same props as `ResultGrid` (M1-5): the master session
 * swaps it at `ResultsArea.tsx` when both branches meet. It shows the column names and the first
 * rows in a plain table, and offers "Load more / Load all" when the result stopped at its cap.
 */
export function ResultPlaceholder({ resultId, summary }: ResultPlaceholderProps) {
  const t = useT();
  const shown = Math.min(summary.rowCount, PREVIEW_ROWS);
  const preview = useQuery({
    queryKey: ['result-placeholder', resultId, shown],
    queryFn: () => unwrap(ipc.commands.fetchResultWindow(resultId, 0, PREVIEW_ROWS)),
    enabled: shown > 0,
  });
  const paused = summary.status === 'paused';

  return (
    <div className={styles.root} data-testid="result-placeholder">
      <div className={styles.bar}>
        <span>
          {t('query.result.rows', { count: summary.rowCount })}
          {paused && t('query.result.more')}
        </span>
        {summary.status === 'streaming' && (
          <span className={styles.muted}>{t('query.result.streaming')}</span>
        )}
        {paused && (
          <>
            <Button
              size="sm"
              onClick={() => {
                void ipc.commands.resumeResult(resultId, 'more');
              }}
            >
              {t('query.result.loadMore')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void ipc.commands.resumeResult(resultId, 'all');
              }}
            >
              {t('query.result.loadAll')}
            </Button>
          </>
        )}
      </div>
      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              {summary.columns.map((column, index) => (
                <th key={`${column.name}-${String(index)}`} scope="col">
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: preview.data?.rowCount ?? 0 }, (_, row) => (
              <tr key={row}>
                {(preview.data?.columns ?? []).map((column, index) => (
                  <td key={index} data-null={column.values[row] === null || undefined}>
                    {column.values[row] ?? 'NULL'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
