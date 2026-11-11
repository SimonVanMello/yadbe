import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { moveFolder, moveSaved } from './libraryActions';
import { canMoveFolder, type Library, type LibraryRow } from './libraryModel';
import type { LibraryDrag } from './libraryRowProps';

const DRAG_TYPE = 'application/x-yadbe-library';

/** Marks the whole list as the target (a drop beside no row: the library root). */
export const ROOT_DROP = 'root';

export interface RootDrop {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
}

interface Dragged {
  kind: 'folder' | 'query';
  id: string;
}

function parseKey(key: string): Dragged | null {
  if (key.startsWith('f:')) return { kind: 'folder', id: key.slice(2) };
  if (key.startsWith('q:')) return { kind: 'query', id: key.slice(2) };
  return null;
}

/**
 * Drag and drop of the library tree (F-050): a query or a folder dropped on a folder goes into
 * it, on a query goes next to it (into its folder), on the empty part of the list goes to the
 * root. A folder never goes into itself or what it holds.
 */
export function useLibraryDrag(library: Library): {
  drag: LibraryDrag;
  rootDrop: RootDrop;
  dropKey: string | null;
} {
  const [dropKey, setDropKey] = useState<string | null>(null);
  const dragged = useRef<Dragged | null>(null);
  const latest = useRef(library);
  useEffect(() => {
    latest.current = library;
  });

  const handlers = useMemo(() => {
    /** The folder a drop on `target` lands in; `undefined` when the drop is not allowed. */
    const folderFor = (target: LibraryRow | null): string | null | undefined => {
      const item = dragged.current;
      if (!item) return undefined;
      const { folders, queries } = latest.current;
      let folderId: string | null;
      if (target === null) folderId = null;
      else if (target.type === 'folder') folderId = target.folder.id;
      else if (target.type === 'query') folderId = target.query.folderId;
      else return undefined;
      if (item.kind === 'folder') {
        if (!canMoveFolder(folders, item.id, folderId)) return undefined;
        const current = folders.find((folder) => folder.id === item.id);
        return current?.parentId === folderId ? undefined : folderId;
      }
      const current = queries.find((query) => query.id === item.id);
      return current?.folderId === folderId ? undefined : folderId;
    };

    const accept = (event: DragEvent<HTMLElement>, target: LibraryRow | null): boolean => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return false;
      const folderId = folderFor(target);
      event.dataTransfer.dropEffect = folderId === undefined ? 'none' : 'move';
      if (folderId === undefined) return false;
      event.preventDefault();
      return true;
    };

    const perform = (target: LibraryRow | null) => {
      const item = dragged.current;
      const folderId = folderFor(target);
      dragged.current = null;
      setDropKey(null);
      if (!item || folderId === undefined) return;
      const { folders, queries } = latest.current;
      if (item.kind === 'query') {
        const query = queries.find((candidate) => candidate.id === item.id);
        if (query) void moveSaved(query, folderId);
      } else {
        const folder = folders.find((candidate) => candidate.id === item.id);
        if (folder) void moveFolder(folder, folderId);
      }
    };

    const drag: LibraryDrag = {
      start: (event, key) => {
        const item = parseKey(key);
        if (!item) return;
        dragged.current = item;
        event.dataTransfer.setData(DRAG_TYPE, key);
        event.dataTransfer.effectAllowed = 'move';
      },
      over: (event, row) => {
        // The row handles it: the list behind must not take it as a drop on the root.
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
        setDropKey(accept(event, null) ? ROOT_DROP : null);
      },
      onDrop: (event) => {
        event.preventDefault();
        perform(null);
      },
      onDragLeave: () => {
        setDropKey((current) => (current === ROOT_DROP ? null : current));
      },
    };
    return { drag, rootDrop };
  }, []);

  return { ...handlers, dropKey };
}
