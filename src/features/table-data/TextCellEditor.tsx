import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import { matchShortcut } from '../../ui/shortcuts';
import { editText, formatHint, parseInput } from './cellValues';
import { stopMenu, type CellEditorProps, type EditMove } from './cellEditorTypes';
import styles from './CellEditor.module.css';

/** Longer texts (or several lines) are edited in a larger box. */
const MULTILINE_FROM = 80;

/**
 * A text box over the cell, checked as typed against the column's kind: one line, or several
 * (JSON, long texts, `Shift+Enter`). Typing after `Mod+Backspace` leaves NULL for a value.
 */
export function TextCellEditor({
  column,
  initial,
  typed,
  label,
  onCommit,
  onCancel,
}: CellEditorProps) {
  const t = useT();
  const start = typed ?? editText(initial);
  const [text, setText] = useState(start);
  const [isNull, setIsNull] = useState(typed === null && initial.kind === 'null');
  const [multiline, setMultiline] = useState(
    column.kind === 'json' || start.includes('\n') || start.length > MULTILINE_FROM,
  );
  const [showError, setShowError] = useState(false);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);

  const parsed = isNull ? null : parseInput(text, column);
  const error = parsed && !parsed.ok ? t(parsed.error, parsed.params) : null;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [multiline]);

  const commit = (move: EditMove) => {
    if (done.current) return;
    if (isNull) {
      done.current = true;
      onCommit({ kind: 'null' }, move);
      return;
    }
    if (!parsed?.ok) {
      setShowError(true);
      return;
    }
    done.current = true;
    onCommit(parsed.value, move);
  };

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (matchShortcut(event, 'Mod+Backspace')) {
      event.preventDefault();
      setIsNull(true);
      setText('');
      setShowError(false);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      commit(event.shiftKey ? 'left' : 'right');
      return;
    }
    if (event.key !== 'Enter') return;
    if (multiline) {
      // Several lines: Enter is a new line, Mod+Enter commits.
      if (matchShortcut(event, 'Mod+Enter')) {
        event.preventDefault();
        commit('down');
      }
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      setText((value) => `${value}\n`);
      setIsNull(false);
      setMultiline(true);
      return;
    }
    event.preventDefault();
    commit('down');
  };

  const common = {
    'aria-label': label,
    'aria-invalid': showError && error !== null ? true : undefined,
    className: multiline ? styles.area : styles.input,
    'data-null': isNull || undefined,
    value: text,
    spellCheck: false,
    placeholder: isNull ? 'NULL' : (formatHint(column.kind) ?? ''),
    onKeyDown,
    onChange: (event: { target: { value: string } }) => {
      setText(event.target.value);
      setIsNull(false);
      setShowError(false);
    },
    onBlur: () => {
      // Clicking elsewhere keeps a valid value, and drops one that is not.
      if (isNull || parsed?.ok) commit('none');
      else cancel();
    },
    onContextMenu: stopMenu,
  };

  return (
    <div className={multiline ? `${styles.editor} ${styles.expanded}` : styles.editor}>
      {multiline ? (
        <textarea ref={inputRef} rows={8} {...common} />
      ) : (
        <input ref={inputRef} type="text" autoComplete="off" {...common} />
      )}
      <div className={styles.hint}>
        {showError && error ? (
          <span className={styles.error} role="alert">
            {error}
          </span>
        ) : (
          <>
            <span className={styles.state} data-null={isNull || undefined}>
              {isNull ? 'NULL' : text === '' ? t('tableData.editor.empty') : column.typeName}
            </span>
            <span className={styles.keys}>
              {multiline ? t('tableData.editor.keysMultiline') : t('tableData.editor.keys')}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
