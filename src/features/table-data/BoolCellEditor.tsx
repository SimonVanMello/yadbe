import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import { matchesAction } from '../../app/actions';
import { parseBool } from './cellValues';
import { stopMenu, type CellEditorProps, type EditMove } from './cellEditorTypes';
import styles from './CellEditor.module.css';

type BoolChoice = 'true' | 'false' | 'null';

/** True, false or NULL: arrows or `t` / `f` / `n` choose, `Enter` commits. */
export function BoolCellEditor({
  column,
  initial,
  typed,
  label,
  onCommit,
  onCancel,
}: CellEditorProps) {
  const t = useT();
  const choices: BoolChoice[] = column.nullable ? ['true', 'false', 'null'] : ['true', 'false'];
  const fromTyped = (key: string | null): BoolChoice | null => {
    if (key === null) return null;
    if (key.toLowerCase() === 'n' && column.nullable) return 'null';
    const value = parseBool(key);
    return value === null ? null : value ? 'true' : 'false';
  };
  const current: BoolChoice =
    initial.kind === 'bool'
      ? initial.value
        ? 'true'
        : 'false'
      : initial.kind === 'null'
        ? 'null'
        : 'false';
  const [choice, setChoice] = useState<BoolChoice>(fromTyped(typed) ?? current);
  const groupRef = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useEffect(() => {
    groupRef.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?.focus({ preventScroll: true });
  }, [choice]);

  const commit = (value: BoolChoice, move: EditMove) => {
    if (done.current) return;
    done.current = true;
    onCommit(value === 'null' ? { kind: 'null' } : { kind: 'bool', value: value === 'true' }, move);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = choices.indexOf(choice);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      setChoice(choices[(index + 1) % choices.length] ?? choice);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      setChoice(choices[(index - 1 + choices.length) % choices.length] ?? choice);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(choice, event.key === 'Enter' ? 'down' : 'none');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      commit(choice, event.shiftKey ? 'left' : 'right');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      done.current = true;
      onCancel();
    } else if (matchesAction(event, 'table.setNull') && column.nullable) {
      event.preventDefault();
      commit('null', 'none');
    } else {
      const picked = fromTyped(event.key.length === 1 ? event.key : null);
      if (picked) {
        event.preventDefault();
        setChoice(picked);
      }
    }
  };

  return (
    <div className={styles.editor}>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={label}
        className={styles.choices}
        onKeyDown={onKeyDown}
        onContextMenu={stopMenu}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) commit(choice, 'none');
        }}
      >
        {choices.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={choice === value}
            tabIndex={choice === value ? 0 : -1}
            className={styles.choice}
            data-null={value === 'null' || undefined}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              commit(value, 'none');
            }}
          >
            {value === 'null' ? 'NULL' : value}
          </button>
        ))}
      </div>
      <div className={styles.hint}>
        <span className={styles.keys}>{t('tableData.editor.keysChoice')}</span>
      </div>
    </div>
  );
}
