import type { TableColumn, Value } from '../../ipc';

/** Where the focus goes once a value is committed. */
export type EditMove = 'down' | 'right' | 'left' | 'none';

export interface CellEditorProps {
  column: TableColumn;
  /** The cell's value when editing starts (a pending one included). */
  initial: Value;
  /** The key that started the edit: replaces the value. */
  typed: string | null;
  /** Accessible name ("Edit email, row 4"). */
  label: string;
  onCommit: (value: Value, move: EditMove) => void;
  onCancel: () => void;
}

/** The grid's context menu stays closed over an editor. */
export function stopMenu(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}
