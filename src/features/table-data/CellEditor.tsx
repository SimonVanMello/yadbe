import { BoolCellEditor } from './BoolCellEditor';
import type { CellEditorProps } from './cellEditorTypes';
import { EnumCellEditor } from './EnumCellEditor';
import { TextCellEditor } from './TextCellEditor';

/**
 * The editor drawn over a cell (F-082), by kind: a tri-state choice for booleans, a list for
 * enums, a text box everywhere else (several lines for JSON and long texts), checked as typed.
 * `Enter` commits and moves down, `Tab` moves right, `Esc` cancels, `Mod+Backspace` makes the
 * value NULL (NULL and the empty string stay distinct).
 */
export function CellEditor(props: CellEditorProps) {
  const { column } = props;
  if (column.kind === 'bool') return <BoolCellEditor {...props} />;
  if (column.enumValues) return <EnumCellEditor {...props} enumValues={column.enumValues} />;
  return <TextCellEditor {...props} />;
}
