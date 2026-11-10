import { useState, type CSSProperties, type ReactNode } from 'react';

import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import styles from './CellViewer.module.css';
import { countNodes, type JsonNode } from './jsonTree';

/** Children shown per container before "show more". */
const CHUNK = 200;
/** Trees larger than this open collapsed below the first level. */
const OPEN_ALL_UNDER = 2000;

/** How containers open at first: by size, all of them, or only the root. */
export type Openness = 'auto' | 'all' | 'none';

interface JsonViewProps {
  tree: JsonNode;
  /** The viewer remounts the view (new `key`) to expand or collapse everything. */
  openness: Openness;
}

function depthStyle(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties;
}

/** A pretty-printed, foldable JSON tree whose numbers are shown exactly as stored. */
export function JsonView({ tree, openness }: JsonViewProps) {
  const t = useT();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const [small] = useState(() => countNodes(tree, OPEN_ALL_UNDER) < OPEN_ALL_UNDER);

  const isOpen = (path: string, depth: number) => {
    const override = overrides.get(path);
    if (override !== undefined) return override;
    if (depth === 0 || openness === 'all') return true;
    if (openness === 'none') return false;
    return small || depth < 1;
  };

  const toggle = (path: string, open: boolean) => {
    setOverrides((map) => new Map(map).set(path, !open));
  };

  const lines: ReactNode[] = [];
  const scalar = (node: JsonNode): ReactNode => {
    switch (node.type) {
      case 'string':
        return <span className={styles.string}>{JSON.stringify(node.value)}</span>;
      case 'number':
        return <span className={styles.number}>{node.raw}</span>;
      case 'bool':
        return <span className={styles.literal}>{node.value ? 'true' : 'false'}</span>;
      case 'null':
        return <span className={styles.literal}>null</span>;
      default:
        return null;
    }
  };

  const walk = (
    node: JsonNode,
    key: string | null,
    path: string,
    depth: number,
    comma: boolean,
  ) => {
    const label =
      key === null ? null : (
        <>
          <span className={styles.key}>{JSON.stringify(key)}</span>
          <span className={styles.punct}>: </span>
        </>
      );
    const tail = comma ? <span className={styles.punct}>,</span> : null;
    if (node.type !== 'object' && node.type !== 'array') {
      lines.push(
        <div key={path} className={styles.line} style={depthStyle(depth)}>
          <span className={styles.toggleSpacer} />
          {label}
          {scalar(node)}
          {tail}
        </div>,
      );
      return;
    }
    const [open, close] = node.type === 'object' ? ['{', '}'] : ['[', ']'];
    const size = node.type === 'object' ? node.entries.length : node.items.length;
    const expanded = size > 0 && isOpen(path, depth);
    const count =
      node.type === 'object'
        ? t('grid.viewer.keys', { count: size })
        : t('grid.viewer.items', { count: size });
    lines.push(
      <div key={path} className={styles.line} style={depthStyle(depth)}>
        {size > 0 ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-label={count}
            onClick={() => {
              toggle(path, expanded);
            }}
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
          </button>
        ) : (
          <span className={styles.toggleSpacer} />
        )}
        {label}
        <span className={styles.punct}>{open}</span>
        {!expanded && (
          <>
            {size > 0 && <span className={styles.punct}>…</span>}
            <span className={styles.punct}>{close}</span>
            {tail}
            {size > 0 && <span className={styles.summary}>{count}</span>}
          </>
        )}
      </div>,
    );
    if (!expanded) return;
    const limit = limits.get(path) ?? CHUNK;
    const shown = Math.min(size, limit);
    for (let i = 0; i < shown; i++) {
      const last = i === size - 1;
      if (node.type === 'object') {
        const entry = node.entries[i];
        if (entry) walk(entry[1], entry[0], `${path}/${String(i)}`, depth + 1, !last);
      } else {
        const item = node.items[i];
        if (item) walk(item, null, `${path}/${String(i)}`, depth + 1, !last);
      }
    }
    if (shown < size) {
      lines.push(
        <div key={`${path}/more`} className={styles.line} style={depthStyle(depth + 1)}>
          <span className={styles.toggleSpacer} />
          <button
            type="button"
            className={styles.more}
            onClick={() => {
              setLimits((map) => new Map(map).set(path, limit + CHUNK));
            }}
          >
            {t('grid.viewer.more', { count: Math.min(CHUNK, size - shown) })}
          </button>
        </div>,
      );
    }
    lines.push(
      <div key={`${path}/end`} className={styles.line} style={depthStyle(depth)}>
        <span className={styles.toggleSpacer} />
        <span className={styles.punct}>{close}</span>
        {tail}
      </div>,
    );
  };

  walk(tree, null, '$', 0, false);
  return <div className={styles.code}>{lines}</div>;
}
