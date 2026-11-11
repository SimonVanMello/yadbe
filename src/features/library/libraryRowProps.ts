import type { DragEvent } from 'react';

import type { LibraryRow } from './libraryModel';

/** What every row of the library tree gets from the virtualized list. */
export interface LibraryRowCommon {
  id: string;
  index: number;
  /** The row the keyboard and the detail panel are on. */
  active: boolean;
  posInSet: number;
  setSize: number;
  offset: number;
  height: number;
  onSelect: (index: number) => void;
}

/** Drag and drop between rows: moving a query or a folder into a folder (F-050). */
export interface LibraryDrag {
  start: (event: DragEvent<HTMLElement>, key: string) => void;
  over: (event: DragEvent<HTMLElement>, row: LibraryRow) => void;
  leave: (row: LibraryRow) => void;
  drop: (event: DragEvent<HTMLElement>, row: LibraryRow) => void;
  end: () => void;
}
