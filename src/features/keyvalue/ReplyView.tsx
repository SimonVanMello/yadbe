import { useEffect, useMemo, type CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import type { KvReplyView } from '../../ipc';
import { DataGrid } from '../grid/DataGrid';
import { JsonView } from '../grid/JsonView';
import { tryParseJson } from '../grid/jsonTree';
import { createResultRowSource } from '../grid/resultRowSource';
import styles from './KvConsole.module.css';

function GridReply({
  reply,
  label,
}: {
  reply: Extract<KvReplyView, { kind: 'grid' }>;
  label: string;
}) {
  const source = useMemo(
    () => createResultRowSource(reply.resultId, reply.columns, reply.rowCount),
    [reply.resultId, reply.columns, reply.rowCount],
  );
  useEffect(() => {
    source.revive();
    return () => {
      source.dispose();
    };
  }, [source]);
  return (
    <div
      className={styles.grid}
      // As tall as its rows, up to twelve: a short reply takes little room in the list.
      style={{ '--reply-rows': Math.min(Math.max(reply.rowCount, 1), 12) } as CSSProperties}
    >
      <DataGrid
        source={source}
        sourceKey={`kv-reply-${String(reply.resultId)}`}
        label={label}
        readOnly
      />
    </div>
  );
}

/** A console reply: a value, an empty collection, a grid of rows (in the backend) or a tree. */
export function ReplyView({ reply, label }: { reply: KvReplyView; label: string }) {
  const t = useT();
  switch (reply.kind) {
    case 'nil':
      return <span className={styles.nil}>(nil)</span>;
    case 'empty':
      return <span className={styles.nil}>{t('keyValue.console.empty')}</span>;
    case 'scalar':
      return (
        <pre className={styles.scalar} data-scalar={reply.scalar}>
          {reply.scalar === 'int'
            ? `(integer) ${reply.value.text}`
            : reply.scalar === 'double'
              ? `(double) ${reply.value.text}`
              : reply.scalar === 'error'
                ? `(error) ${reply.value.text}`
                : reply.value.text}
        </pre>
      );
    case 'grid':
      return <GridReply reply={reply} label={label} />;
    case 'tree': {
      const tree = tryParseJson(reply.json);
      return (
        <div className={styles.tree}>
          {tree ? <JsonView tree={tree} openness="auto" /> : <pre>{reply.json}</pre>}
          {reply.truncated && <p className={styles.truncated}>{t('keyValue.console.truncated')}</p>}
        </div>
      );
    }
  }
}
