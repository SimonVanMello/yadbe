import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/useT';
import { matchesAction } from '../../app/actions';
import { editText } from './cellValues';
import { stopMenu, type CellEditorProps, type EditMove } from './cellEditorTypes';
import styles from './CellEditor.module.css';

/** The labels of an enum (and NULL when allowed) as a list; a click or `Enter` commits. */
export function EnumCellEditor({
  column,
  initial,
  typed,
  label,
  onCommit,
  onCancel,
  enumValues,
}: CellEditorProps & { enumValues: string[] }) {
  const t = useT();
  const NULL_OPTION = '\u0000null';
  const options = column.nullable ? [NULL_OPTION, ...enumValues] : enumValues;
  const startText = initial.kind === 'null' ? NULL_OPTION : editText(initial);
  const typedMatch =
    typed === null
      ? undefined
      : enumValues.find((value) => value.toLowerCase().startsWith(typed.toLowerCase()));
  const [value, setValue] = useState(
    typedMatch ?? (options.includes(startText) ? startText : (options[0] ?? '')),
  );
  const selectRef = useRef<HTMLSelectElement>(null);
  const done = useRef(false);

  useEffect(() => {
    selectRef.current?.focus({ preventScroll: true });
  }, []);

  const commit = (picked: string, move: EditMove) => {
    if (done.current) return;
    done.current = true;
    onCommit(
      picked === NULL_OPTION
        ? { kind: 'null' }
        : { kind: column.kind === 'other' ? 'other' : 'text', value: picked },
      move,
    );
  };

  return (
    <div className={`${styles.editor} ${styles.expanded}`}>
      <select
        ref={selectRef}
        aria-label={label}
        className={styles.list}
        size={Math.min(8, options.length)}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        onClick={(event) => {
          if (event.target instanceof HTMLOptionElement) commit(event.target.value, 'none');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(value, 'down');
          } else if (event.key === 'Tab') {
            event.preventDefault();
            commit(value, event.shiftKey ? 'left' : 'right');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            done.current = true;
            onCancel();
          } else if (matchesAction(event, 'table.setNull') && column.nullable) {
            event.preventDefault();
            commit(NULL_OPTION, 'none');
          }
        }}
        onBlur={() => {
          if (!done.current) commit(value, 'none');
        }}
        onContextMenu={stopMenu}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option === NULL_OPTION ? 'NULL' : option}
          </option>
        ))}
      </select>
      <div className={styles.hint}>
        <span className={styles.keys}>{t('tableData.editor.keysChoice')}</span>
      </div>
    </div>
  );
}
