import { useQuery } from '@tanstack/react-query';

import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { usePreference } from '../preferences/preferenceStore';
import { describeCell, DISPLAY_CHARS } from './cellDisplay';
import styles from './RowDetail.module.css';
import { blockKind, blockText, blockTruncated, type RowBlock, type RowSource } from './rowSource';
import { ViewerModeSwitch, type ViewerPanel } from './ViewerModeSwitch';

interface RowDetailProps {
  source: RowSource;
  /** Identifies the source in the query cache (a result id). */
  sourceKey: string;
  /** The focused row, `null` without one. */
  row: number | null;
  /** Data columns in the order the grid shows them. */
  order: readonly number[];
  onMode: (mode: ViewerPanel) => void;
  /** Moves to the previous (-1) or next (1) row. */
  onMove: (delta: number) => void;
  /** Shows the whole value of a cell in the cell viewer. */
  onOpenCell: (dataCol: number) => void;
  onClose: () => void;
}

/** Side panel showing the focused row as a vertical form (F-068): one line per column. */
export function RowDetail({
  source,
  sourceKey,
  row,
  order,
  onMode,
  onMove,
  onOpenCell,
  onClose,
}: RowDetailProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const nullText = usePreference('nullText');
  const query = useQuery({
    queryKey: ['grid-row', sourceKey, row],
    queryFn: async (): Promise<RowBlock | null> => {
      if (row === null) return null;
      const blocks = await source.read(row, row + 1);
      return (
        blocks.find((block) => row >= block.offset && row < block.offset + block.rowCount) ?? null
      );
    },
    enabled: row !== null,
    // A row of a table tab changes with its pending edits: read it again each time.
    staleTime: 0,
    gcTime: 30_000,
  });
  const block = query.data;
  const rowCount = source.rowCount;
  const number = new Intl.NumberFormat(locale);

  let body;
  if (row === null) {
    body = <p className={styles.notice}>{t('grid.row.none')}</p>;
  } else if (query.isError) {
    body = (
      <p className={styles.notice} role="alert">
        {t('grid.row.failed')}
      </p>
    );
  } else if (!block) {
    body = (
      <p className={styles.notice} role="status">
        <Spinner />
        {t('grid.row.loading')}
      </p>
    );
  } else {
    const index = row - block.offset;
    body = (
      <dl className={styles.fields}>
        {order.map((dataCol) => {
          const column = source.columns[dataCol];
          if (!column) return null;
          const text = blockText(block, index, dataCol);
          const kind = blockKind(block, index, dataCol, column.kind);
          const cut =
            blockTruncated(block, index, dataCol) || (text?.length ?? 0) > DISPLAY_CHARS * 4;
          const display = describeCell(text, kind);
          return (
            <div key={dataCol} className={styles.field} data-column={column.name}>
              <dt className={styles.name}>
                <span className={styles.columnName}>{column.name}</span>
                {column.typeName && <span className={styles.type}>{column.typeName}</span>}
              </dt>
              <dd className={styles.value}>
                {display.type === 'null' && <span className={styles.null}>{nullText}</span>}
                {display.type === 'empty' && (
                  <span className={styles.empty}>{t('grid.empty')}</span>
                )}
                {display.type === 'plain' && display.text}
                {display.type === 'marked' &&
                  display.parts.map((part, i) =>
                    part.mark ? (
                      <span key={i} className={styles.mark}>
                        {part.text}
                      </span>
                    ) : (
                      part.text
                    ),
                  )}
                {(cut || (text?.length ?? 0) > DISPLAY_CHARS) && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className={styles.more}
                      onClick={() => {
                        onOpenCell(dataCol);
                      }}
                    >
                      {t('grid.row.openCell')}
                    </button>
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }

  return (
    <aside className={styles.panel} aria-label={t('grid.row.title')}>
      <header className={styles.header}>
        <ViewerModeSwitch value="row" onChange={onMode} />
        <span className={styles.position}>
          {row === null
            ? ''
            : t('grid.row.position', {
                row: number.format(row + 1),
                total: number.format(rowCount),
              })}
        </span>
        <IconButton
          icon="arrowUp"
          size="sm"
          label={t('grid.row.previous')}
          disabled={row === null || row <= 0}
          onClick={() => {
            onMove(-1);
          }}
        />
        <IconButton
          icon="arrowDown"
          size="sm"
          label={t('grid.row.next')}
          disabled={row === null || row >= rowCount - 1}
          onClick={() => {
            onMove(1);
          }}
        />
        <IconButton icon="close" size="sm" label={t('grid.viewer.hide')} onClick={onClose} />
      </header>
      <div className={styles.body}>{body}</div>
    </aside>
  );
}
