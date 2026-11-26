import { useMemo, useRef, useState, type DragEvent } from 'react';

import { moveToGroup } from '../connections/connectionActions';
import type { ConnectionSummary } from '../connections/model';
import type { SidebarTreeRow } from './sidebarRows';

const DRAG_TYPE = 'application/x-yadbe-connection';

/** Marks the whole list as the target (a drop beside every row: no folder). */
export const ROOT_DROP = 'root';

/** Drag handlers of a connection or folder row. */
export interface ConnectionDrag {
  start: (event: DragEvent<HTMLElement>, connection: ConnectionSummary) => void;
  over: (event: DragEvent<HTMLElement>, row: SidebarTreeRow) => void;
  leave: (row: SidebarTreeRow) => void;
  drop: (event: DragEvent<HTMLElement>, row: SidebarTreeRow) => void;
  end: () => void;
}

export interface RootDrop {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
}

/** Whether the event happened on the list itself, not on one of its rows. */
function outsideRows(event: DragEvent<HTMLElement>): boolean {
  return !(event.target instanceof Element) || event.target.closest('[role="treeitem"]') === null;
}

/**
 * Drag and drop of connections into folders (F-007): a connection dropped on a folder goes into
 * it, on another connection goes next to it (into its folder), on the empty part of the list goes
 * out of every folder. Explorer rows are no target.
 */
export function useConnectionDrag(): {
  drag: ConnectionDrag;
  rootDrop: RootDrop;
  dropKey: string | null;
} {
  const [dropKey, setDropKey] = useState<string | null>(null);
  const dragged = useRef<ConnectionSummary | null>(null);

  const handlers = useMemo(() => {
    /** The folder a drop on `target` lands in; `undefined` when the drop changes nothing. */
    const groupFor = (target: SidebarTreeRow | null): string | null | undefined => {
      const connection = dragged.current;
      if (!connection) return undefined;
      let groupId: string | null;
      if (target === null) groupId = null;
      else if (target.type === 'group') groupId = target.group.id;
      else if (target.type === 'connection') groupId = target.connection.groupId;
      else return undefined;
      return connection.groupId === groupId ? undefined : groupId;
    };

    const accept = (event: DragEvent<HTMLElement>, target: SidebarTreeRow | null): boolean => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return false;
      const groupId = groupFor(target);
      event.dataTransfer.dropEffect = groupId === undefined ? 'none' : 'move';
      if (groupId === undefined) return false;
      event.preventDefault();
      return true;
    };

    const perform = (target: SidebarTreeRow | null) => {
      const connection = dragged.current;
      const groupId = groupFor(target);
      dragged.current = null;
      setDropKey(null);
      if (connection && groupId !== undefined) void moveToGroup(connection, groupId);
    };

    const drag: ConnectionDrag = {
      start: (event, connection) => {
        dragged.current = connection;
        event.dataTransfer.setData(DRAG_TYPE, connection.id);
        event.dataTransfer.effectAllowed = 'move';
      },
      over: (event, row) => {
        // The row handles it: the list behind must not take it as a drop out of every folder.
        event.stopPropagation();
        setDropKey(accept(event, row) ? row.key : null);
      },
      leave: (row) => {
        setDropKey((current) => (current === row.key ? null : current));
      },
      drop: (event, row) => {
        event.preventDefault();
        event.stopPropagation();
        perform(row);
      },
      end: () => {
        dragged.current = null;
        setDropKey(null);
      },
    };

    const rootDrop: RootDrop = {
      onDragOver: (event) => {
        // Over an explorer row (no handler of its own): no drop at all.
        const root = outsideRows(event) && accept(event, null);
        if (!root && event.dataTransfer.types.includes(DRAG_TYPE)) {
          event.dataTransfer.dropEffect = 'none';
        }
        setDropKey(root ? ROOT_DROP : null);
      },
      onDrop: (event) => {
        event.preventDefault();
        if (outsideRows(event)) perform(null);
        else {
          dragged.current = null;
          setDropKey(null);
        }
      },
      onDragLeave: () => {
        setDropKey((current) => (current === ROOT_DROP ? null : current));
      },
    };
    return { drag, rootDrop };
  }, []);

  return { ...handlers, dropKey };
}
