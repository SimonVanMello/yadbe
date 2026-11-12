import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { showError } from '../../app/errors/presentError';
import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { toast } from '../../ui/toastStore';
import { useRowHeight } from '../sidebar/useRowHeight';
import {
  flattenDocuments,
  nodeJson,
  pathText,
  previewOf,
  type DocNode,
  type DocRow,
  type Openness,
} from './docTree';
import styles from './DocumentsView.module.css';

/** Documents read per call; the backend's window. */
const WINDOW = 500;
const OVERSCAN = 20;
const INITIAL_RECT = { width: 800, height: 480 };
/** "Expand all" opens this deep. */
const EXPAND_ALL_DEPTH = 32;

/** A document shown with its pending changes (an editing layer, M4-4). */
export interface DocShown {
  node: DocNode;
  state: 'modified' | 'deleted';
  /** Paths whose value changes (their rows and everything inside are marked). */
  changed: readonly (readonly (string | number)[])[];
}

/** What an editing layer adds to the view: changed documents, new ones, row actions. */
export interface DocumentsEditing {
  /** Document `index` as it will be, `undefined`: unchanged. */
  document: (index: number) => DocShown | undefined;
  /** New documents, shown after the result's. */
  added: readonly DocNode[];
  /** Changes whenever what the two above give does. */
  version: string;
  /** More entries of a row's context menu (`added`: a new document's row). */
  menu: (row: DocRow, added: boolean) => ReactNode;
  /** Double click or F2 on a row. */
  onEdit: (row: DocRow, added: boolean) => void;
}

export interface DocumentsViewProps {
  /** Documents in the result. */
  count: number;
  /** Reads documents `offset .. offset + limit`; rejects with what the backend said. */
  load: (offset: number, limit: number) => Promise<DocNode[]>;
  /** Accessible name of the list. */
  label: string;
  editing?: DocumentsEditing;
}

function startsWith(path: readonly (string | number)[], prefix: readonly (string | number)[]) {
  return prefix.length <= path.length && prefix.every((seg, i) => seg === path[i]);
}

/** The text a row shows for its value. */
function valueText(row: DocRow, t: ReturnType<typeof useT>): string {
  const { node } = row;
  switch (node.type) {
    case 'scalar':
      return node.text;
    case 'object':
      return row.open ? '' : previewOf(node);
    case 'array':
      return row.open ? '' : previewOf(node);
  }
  return t('documents.empty');
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ variant: 'success', title: what });
  } catch (error) {
    showError(error);
  }
}

/**
 * Documents as foldable trees (F-063's JSON view for whole documents), one virtualized list for
 * all of them: each document opens on its fields, a field holding a document or an array opens
 * on demand. Copy a value, its path or the whole document from a row's menu. Fed by plain values
 * (`DocNode`): it knows nothing of the store the documents come from.
 */
export function DocumentsView({ count, load, label, editing }: DocumentsViewProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const [documents, setDocuments] = useState<(DocNode | undefined)[]>([]);
  const [loading, setLoading] = useState(true);
  const [openness, setOpenness] = useState<Openness>({ depth: 1, overrides: new Map() });
  const [active, setActive] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowHeight = useRowHeight();

  // Windows are read in turn; the documents of a result never change, so they are kept.
  useEffect(() => {
    const run = { cancelled: false };
    const read = async () => {
      const all: DocNode[] = [];
      for (let offset = 0; offset < count; offset += WINDOW) {
        const batch = await load(offset, Math.min(WINDOW, count - offset));
        if (run.cancelled) return;
        all.push(...batch);
        setDocuments([...all]);
      }
    };
    read()
      .catch((error: unknown) => {
        if (!run.cancelled) showError(error);
      })
      .finally(() => {
        if (!run.cancelled) setLoading(false);
      });
    return () => {
      run.cancelled = true;
    };
  }, [count, load]);

  const version = editing?.version;
  const shown = useMemo(() => {
    if (!editing) return documents;
    const changed = documents.map((node, i) => (node ? (editing.document(i)?.node ?? node) : node));
    return documents.length >= count ? [...changed, ...editing.added] : changed;
    // `version` stands for what `editing` gives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, count, version]);
  const rows = useMemo(() => flattenDocuments(shown, 0, openness), [shown, openness]);

  /** A row's pending-change mark. */
  const stateOf = (row: DocRow): 'modified' | 'deleted' | 'inserted' | undefined => {
    if (!editing) return undefined;
    if (row.document >= count) return 'inserted';
    const doc = editing.document(row.document);
    if (!doc) return undefined;
    if (doc.state === 'deleted') return 'deleted';
    if (row.path.length === 0) return 'modified';
    return doc.changed.some((path) => startsWith(row.path, path)) ? 'modified' : undefined;
  };

  // eslint-disable-next-line react-hooks/incompatible-library -- rows are not memoized children
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    initialRect: INITIAL_RECT,
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb(rect.height === 0 ? INITIAL_RECT : rect);
      }),
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const toggle = (row: DocRow) => {
    if (row.node.type === 'scalar') return;
    setOpenness((current) => ({
      ...current,
      overrides: new Map(current.overrides).set(row.key, !row.open),
    }));
  };

  const documentOf = (row: DocRow) => shown[row.document];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[active];
    const move = (index: number) => {
      const next = Math.max(0, Math.min(rows.length - 1, index));
      setActive(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(active + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(active - 1);
        return;
      case 'Home':
        event.preventDefault();
        move(0);
        return;
      case 'End':
        event.preventDefault();
        move(rows.length - 1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (row && row.node.type !== 'scalar' && !row.open) toggle(row);
        else move(active + 1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (row && row.node.type !== 'scalar' && row.open) toggle(row);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (row) toggle(row);
        return;
      case 'F2':
        event.preventDefault();
        if (row && editing) editing.onEdit(row, row.document >= count);
    }
  };

  const items = virtualizer.getVirtualItems();
  return (
    <div className={styles.view}>
      <div className={styles.bar}>
        <span className={styles.count}>{t('documents.count', { count })}</span>
        {loading && <Spinner />}
        <span className={styles.spacer} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpenness({ depth: EXPAND_ALL_DEPTH, overrides: new Map() });
          }}
        >
          {t('documents.expandAll')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpenness({ depth: 1, overrides: new Map() });
          }}
        >
          {t('documents.collapseAll')}
        </Button>
      </div>
      <div
        ref={scrollRef}
        className={styles.list}
        role="tree"
        aria-label={label}
        tabIndex={0}
        aria-activedescendant={rows[active] ? `doc-row-${String(active)}` : undefined}
        onKeyDown={onKeyDown}
      >
        <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const container = row.node.type !== 'scalar';
            const document = documentOf(row);
            const value = valueText(row, t);
            const kind = row.node.type === 'scalar' ? row.node.kind : row.node.type;
            return (
              <ContextMenu
                key={row.key}
                content={
                  <>
                    <ContextMenuItem
                      icon="copy"
                      onSelect={() => {
                        void copy(nodeJson(row.node, 2), t('documents.copied.value'));
                      }}
                    >
                      {t('documents.copyValue')}
                    </ContextMenuItem>
                    {row.path.length > 0 && (
                      <ContextMenuItem
                        icon="copy"
                        onSelect={() => {
                          void copy(pathText(row.path), t('documents.copied.path'));
                        }}
                      >
                        {t('documents.copyPath')}
                      </ContextMenuItem>
                    )}
                    {document && (
                      <ContextMenuItem
                        icon="copy"
                        onSelect={() => {
                          void copy(nodeJson(document, 2), t('documents.copied.document'));
                        }}
                      >
                        {t('documents.copyDocument')}
                      </ContextMenuItem>
                    )}
                    {editing?.menu(row, row.document >= count)}
                  </>
                }
              >
                <div
                  id={`doc-row-${String(item.index)}`}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={container ? row.open : undefined}
                  aria-selected={item.index === active}
                  data-active={item.index === active || undefined}
                  data-state={stateOf(row)}
                  data-depth={row.depth}
                  className={styles.row}
                  style={
                    {
                      transform: `translateY(${String(item.start)}px)`,
                      '--depth': row.depth,
                    } as CSSProperties
                  }
                  onClick={() => {
                    setActive(item.index);
                    toggle(row);
                  }}
                  onDoubleClick={() => {
                    editing?.onEdit(row, row.document >= count);
                  }}
                >
                  <span className={styles.twisty}>
                    {container && <Icon name={row.open ? 'chevronDown' : 'chevronRight'} />}
                  </span>
                  {row.label === null ? (
                    <span className={styles.document}>
                      {row.document >= count
                        ? t('documents.newDocument', {
                            number: formatNumber(locale, row.document - count + 1),
                          })
                        : t('documents.document', {
                            number: formatNumber(locale, row.document + 1),
                          })}
                    </span>
                  ) : (
                    <span className={styles.label}>{row.label}</span>
                  )}
                  {container && (
                    <span className={styles.size}>
                      {row.node.type === 'array'
                        ? t('documents.items', { count: row.size })
                        : t('documents.fields', { count: row.size })}
                    </span>
                  )}
                  <span className={styles.value} data-kind={kind}>
                    {value}
                  </span>
                  {row.node.type === 'scalar' && row.node.label !== null && (
                    <span className={styles.type}>{row.node.label}</span>
                  )}
                </div>
              </ContextMenu>
            );
          })}
        </div>
        {!loading && count === 0 && <p className={styles.empty}>{t('documents.empty')}</p>}
      </div>
    </div>
  );
}
