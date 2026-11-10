import { useState, type CSSProperties, type ReactNode } from 'react';

import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import styles from './CellViewer.module.css';
import type { Openness } from './JsonView';
import type { XmlNode } from './prettyValue';

const CHUNK = 200;

interface XmlViewProps {
  nodes: XmlNode[];
  openness: Openness;
}

function depthStyle(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties;
}

/** A pretty-printed, foldable XML document. */
export function XmlView({ nodes, openness }: XmlViewProps) {
  const t = useT();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(new Map());

  const isOpen = (path: string, depth: number) => {
    const override = overrides.get(path);
    if (override !== undefined) return override;
    if (openness === 'all') return true;
    if (openness === 'none') return depth === 0;
    return depth < 3;
  };

  const lines: ReactNode[] = [];
  const attributes = (attrs: [string, string][]) =>
    attrs.map(([name, value]) => (
      <span key={name}>
        {' '}
        <span className={styles.attrName}>{name}</span>
        <span className={styles.punct}>=</span>
        <span className={styles.string}>{JSON.stringify(value)}</span>
      </span>
    ));

  const walk = (node: XmlNode, path: string, depth: number) => {
    const line = (content: ReactNode, toggle: ReactNode = null, key = path) => {
      lines.push(
        <div key={key} className={styles.line} style={depthStyle(depth)}>
          {toggle ?? <span className={styles.toggleSpacer} />}
          {content}
        </div>,
      );
    };
    switch (node.type) {
      case 'text':
        line(<span>{node.text}</span>);
        return;
      case 'cdata':
        line(<span className={styles.comment}>{`<![CDATA[${node.text}]]>`}</span>);
        return;
      case 'comment':
        line(<span className={styles.comment}>{`<!-- ${node.text} -->`}</span>);
        return;
      case 'instruction':
        line(<span className={styles.comment}>{`<?${node.target} ${node.text}?>`}</span>);
        return;
      case 'element':
        break;
    }
    const open = (
      <>
        <span className={styles.punct}>&lt;</span>
        <span className={styles.tag}>{node.name}</span>
        {attributes(node.attributes)}
      </>
    );
    const close = (
      <>
        <span className={styles.punct}>&lt;/</span>
        <span className={styles.tag}>{node.name}</span>
        <span className={styles.punct}>&gt;</span>
      </>
    );
    const [only] = node.children;
    if (node.children.length === 0) {
      line(
        <>
          {open}
          <span className={styles.punct}>/&gt;</span>
        </>,
      );
      return;
    }
    if (node.children.length === 1 && only?.type === 'text' && only.text.length <= 120) {
      line(
        <>
          {open}
          <span className={styles.punct}>&gt;</span>
          <span>{only.text}</span>
          {close}
        </>,
      );
      return;
    }
    const expanded = isOpen(path, depth);
    const toggle = (
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={expanded}
        aria-label={node.name}
        onClick={() => {
          setOverrides((map) => new Map(map).set(path, !expanded));
        }}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
      </button>
    );
    if (!expanded) {
      line(
        <>
          {open}
          <span className={styles.punct}>&gt;…</span>
          {close}
        </>,
        toggle,
      );
      return;
    }
    line(
      <>
        {open}
        <span className={styles.punct}>&gt;</span>
      </>,
      toggle,
    );
    const limit = limits.get(path) ?? CHUNK;
    node.children.slice(0, limit).forEach((child, i) => {
      walk(child, `${path}/${String(i)}`, depth + 1);
    });
    if (node.children.length > limit) {
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
            {t('grid.viewer.more', { count: Math.min(CHUNK, node.children.length - limit) })}
          </button>
        </div>,
      );
    }
    line(close, null, `${path}/end`);
  };

  nodes.forEach((node, i) => {
    walk(node, String(i), 0);
  });
  return <div className={styles.code}>{lines}</div>;
}
