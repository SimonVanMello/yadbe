import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { fileSaver } from '../../ipc/saveFile';
import { IconButton } from '../../ui/IconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { toast } from '../../ui/toastStore';
import styles from './CellViewer.module.css';
import { writeClipboard } from './clipboard';
import { formatCount } from './formatCount';
import { JsonView, type Openness } from './JsonView';
import {
  analyzeValue,
  extensionFor,
  HEX_DUMP_BYTES,
  hexDump,
  TEXT_VIEW_CHARS,
  type ViewerMode,
} from './prettyValue';
import type { RowSource } from './rowSource';
import { useDebouncedValue } from './useDebouncedValue';
import { XmlView } from './XmlView';

interface CellViewerProps {
  source: RowSource;
  /** Identifies the source in the query cache (a result id). */
  sourceKey: string;
  /** The focused cell (data column), `null` without one. */
  target: { row: number; col: number } | null;
  onClose: () => void;
}

const SETTLE_MS = 80;

/** Side panel showing the focused cell's whole value (F-064). */
export function CellViewer({ source, sourceKey, target, onClose }: CellViewerProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const key = useDebouncedValue(
    target ? `${String(target.row)}:${String(target.col)}` : null,
    SETTLE_MS,
  );
  const [row, col] = key === null ? [null, null] : key.split(':').map(Number);
  const valid = row != null && col != null;
  const query = useQuery({
    queryKey: ['grid-cell', sourceKey, row, col],
    queryFn: () => (valid ? source.fullValue(row, col) : Promise.reject(new Error('no cell'))),
    enabled: valid,
    staleTime: Infinity,
    gcTime: 60_000,
  });
  const analysis = useMemo(() => (query.data ? analyzeValue(query.data) : null), [query.data]);
  const [modeChoice, setModeChoice] = useState<ViewerMode | null>(null);
  const [wrap, setWrap] = useState(true);
  const [fold, setFold] = useState<{ openness: Openness; seq: number }>({
    openness: 'auto',
    seq: 0,
  });
  const number = new Intl.NumberFormat(locale);

  const column = valid ? source.columns[col] : undefined;
  const mode: ViewerMode =
    analysis && modeChoice && analysis.modes.includes(modeChoice)
      ? modeChoice
      : (analysis?.preferred ?? 'text');
  const isBinary = query.data?.kind === 'bytes';
  const text = analysis?.text ?? '';

  const copy = () => {
    writeClipboard(text).then(
      () => toast({ variant: 'success', title: t('grid.viewer.copied'), duration: 2000 }),
      (error: unknown) => {
        showError(error, { title: t('grid.copy.failed') });
      },
    );
  };

  const save = () => {
    if (!analysis || !column || row === null) return;
    const extension = isBinary ? 'bin' : extensionFor(mode);
    const filterName = {
      bin: t('grid.viewer.filter.binary'),
      json: t('grid.viewer.filter.json'),
      xml: t('grid.viewer.filter.xml'),
      txt: t('grid.viewer.filter.text'),
    }[extension];
    const safeName = column.name.replace(/[^\w.-]+/g, '_') || 'value';
    fileSaver
      .save({
        title: t('grid.viewer.saveTitle'),
        defaultName: `${safeName}-${String(row + 1)}.${extension}`,
        filters: [
          { name: filterName ?? t('grid.viewer.filter.all'), extensions: [extension] },
          { name: t('grid.viewer.filter.all'), extensions: ['*'] },
        ],
        contents: text,
        encoding: isBinary ? 'hex' : 'utf8',
      })
      .then(
        (path) => {
          if (path) toast({ variant: 'success', title: t('grid.viewer.saved', { path }) });
        },
        (error: unknown) => {
          showError(error, { title: t('grid.viewer.saveFailed') });
        },
      );
  };

  const size = isBinary
    ? formatCount(locale, 'grid.viewer.bytes', text.length / 2)
    : formatCount(locale, 'grid.viewer.chars', text.length);

  let body;
  if (!valid || !column) {
    body = <p className={styles.notice}>{t('grid.viewer.none')}</p>;
  } else if (query.isPending) {
    body = (
      <p className={styles.notice} role="status">
        <Spinner />
        {t('grid.viewer.loading')}
      </p>
    );
  } else if (query.isError) {
    body = (
      <p className={styles.notice} role="alert">
        {t('grid.viewer.failed')}
      </p>
    );
  } else if (!analysis) {
    body = <p className={styles.notice}>{t('grid.viewer.isNull')}</p>;
  } else if (text === '') {
    body = <p className={styles.notice}>{t('grid.viewer.isEmpty')}</p>;
  } else if (mode === 'json' && analysis.json) {
    body = (
      <JsonView
        key={`${key ?? ''}:${String(fold.seq)}`}
        tree={analysis.json}
        openness={fold.openness}
      />
    );
  } else if (mode === 'xml' && analysis.xml) {
    body = (
      <XmlView
        key={`${key ?? ''}:${String(fold.seq)}`}
        nodes={analysis.xml}
        openness={fold.openness}
      />
    );
  } else if (mode === 'hex') {
    const total = text.length / 2;
    body = (
      <>
        {total > HEX_DUMP_BYTES && (
          <p className={styles.limit}>
            {t('grid.viewer.hexLimit', {
              shown: number.format(HEX_DUMP_BYTES),
              total: number.format(total),
            })}
          </p>
        )}
        <pre className={styles.pre}>{hexDump(text).join('\n')}</pre>
      </>
    );
  } else {
    body = (
      <>
        {analysis.jsonError && (
          <p className={styles.limit}>
            {t('grid.viewer.invalidJson', { message: analysis.jsonError })}
          </p>
        )}
        {text.length > TEXT_VIEW_CHARS && (
          <p className={styles.limit}>
            {t('grid.viewer.textLimit', {
              shown: number.format(TEXT_VIEW_CHARS),
              total: number.format(text.length),
            })}
          </p>
        )}
        <pre className={[styles.pre, wrap ? styles.wrap : ''].filter(Boolean).join(' ')}>
          {text.length > TEXT_VIEW_CHARS ? text.slice(0, TEXT_VIEW_CHARS) : text}
        </pre>
      </>
    );
  }

  const ready = !!analysis && text !== '';
  const foldable =
    ready && ((mode === 'json' && !!analysis.json) || (mode === 'xml' && !!analysis.xml));

  return (
    <aside className={styles.viewer} aria-label={t('grid.viewer.title')}>
      <header className={styles.header}>
        <div className={styles.title}>
          <span className={styles.name}>{column?.name ?? t('grid.viewer.title')}</span>
          {column?.typeName && <span className={styles.meta}>{column.typeName}</span>}
          {valid && (
            <span className={styles.meta}>
              {t('grid.viewer.position', { row: number.format(row + 1) })}
            </span>
          )}
        </div>
        <IconButton
          icon="copy"
          size="sm"
          label={t('grid.viewer.copy')}
          disabled={!ready}
          onClick={copy}
        />
        <IconButton
          icon="file"
          size="sm"
          label={t('grid.viewer.save')}
          disabled={!ready}
          onClick={save}
        />
        <IconButton icon="close" size="sm" label={t('grid.viewer.hide')} onClick={onClose} />
      </header>
      {ready && (
        <div className={styles.toolbar}>
          {analysis.modes.length > 1 && (
            <SegmentedControl<ViewerMode>
              label={t('grid.viewer.mode')}
              value={mode}
              options={analysis.modes.map((m) => ({ value: m, label: t(`grid.viewer.mode.${m}`) }))}
              onChange={setModeChoice}
            />
          )}
          <span className={styles.size}>{size}</span>
          <span className={styles.spacer} />
          {mode === 'text' && (
            <IconButton
              icon="list"
              size="sm"
              label={t('grid.viewer.wrap')}
              aria-pressed={wrap}
              onClick={() => {
                setWrap((w) => !w);
              }}
            />
          )}
          {foldable && (
            <>
              <IconButton
                icon="chevronDown"
                size="sm"
                label={t('grid.viewer.expandAll')}
                onClick={() => {
                  setFold((f) => ({ openness: 'all', seq: f.seq + 1 }));
                }}
              />
              <IconButton
                icon="chevronUp"
                size="sm"
                label={t('grid.viewer.collapseAll')}
                onClick={() => {
                  setFold((f) => ({ openness: 'none', seq: f.seq + 1 }));
                }}
              />
            </>
          )}
        </div>
      )}
      <div className={styles.body}>{body}</div>
    </aside>
  );
}
