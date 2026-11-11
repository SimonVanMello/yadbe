import { memo, type CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { useConnection } from '../connections/connectionStore';
import { Highlight } from '../connections/Highlight';
import { rowStyle } from '../sidebar/rowStyle';
import { openSaved, renameSaved } from './libraryActions';
import type { QueryTreeRow } from './libraryModel';
import type { LibraryDrag, LibraryRowCommon } from './libraryRowProps';
import { useLibraryUi } from './libraryStore';
import { QueryMenu } from './QueryMenu';
import styles from './QueryRow.module.css';
import { RenameField } from './RenameField';

interface QueryRowProps extends LibraryRowCommon {
  row: QueryTreeRow;
  renaming: boolean;
  dropping: boolean;
  drag: LibraryDrag;
}

/** The connection a query is bound to, as a tag; nothing for a global query. */
function ScopeTag({ connectionId }: { connectionId: string | null }) {
  const t = useT();
  const connection = useConnection(connectionId);
  if (connectionId === null) return null;
  return (
    <span className={styles.scope} data-testid="scope-tag">
      {connection?.name ?? t('library.unknownConnection')}
    </span>
  );
}

/** A saved query or snippet: its name (matched characters emphasized), trigger and scope. */
export const QueryRow = memo(function QueryRow({
  row,
  id,
  index,
  active,
  posInSet,
  setSize,
  offset,
  height,
  renaming,
  dropping,
  drag,
  onSelect,
}: QueryRowProps) {
  const t = useT();
  const { query, indices } = row;
  const stopRenaming = () => {
    useLibraryUi.getState().startRename(null);
  };
  const snippet = query.snippetTrigger !== null;
  return (
    <ContextMenu content={<QueryMenu query={query} />}>
      <div
        id={id}
        role="treeitem"
        aria-level={row.level}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-selected={active}
        data-row-index={index}
        data-active={active || undefined}
        data-drop={dropping || undefined}
        draggable={!renaming}
        className={styles.row}
        style={{ ...rowStyle(offset, height), '--depth': row.level - 1 } as CSSProperties}
        onClick={() => {
          onSelect(index);
        }}
        onDoubleClick={() => {
          if (!renaming) void openSaved(query);
        }}
        onDragStart={(event) => {
          drag.start(event, row.key);
        }}
        onDragOver={(event) => {
          drag.over(event, row);
        }}
        onDragLeave={() => {
          drag.leave(row);
        }}
        onDrop={(event) => {
          drag.drop(event, row);
        }}
        onDragEnd={drag.end}
      >
        <Icon name={snippet ? 'bolt' : 'bookmark'} className={styles.icon} />
        {renaming ? (
          <RenameField
            value={query.name}
            label={t('library.row.name', { name: query.name })}
            onCommit={(name) => {
              stopRenaming();
              void renameSaved(query, name);
            }}
            onCancel={stopRenaming}
          />
        ) : (
          <>
            <span className={styles.name}>
              <Highlight text={query.name} indices={indices} />
            </span>
            {query.snippetTrigger !== null && (
              <Tooltip content={t('library.tooltip.snippet', { trigger: query.snippetTrigger })}>
                <code className={styles.trigger}>{query.snippetTrigger}</code>
              </Tooltip>
            )}
            <ScopeTag connectionId={query.connectionId} />
          </>
        )}
      </div>
    </ContextMenu>
  );
});
