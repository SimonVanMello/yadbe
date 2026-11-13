import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

import type { Engine } from '../../ipc';
import { cspSafeEditor } from '../../ui/editorCsp';
import { sqlEditorTheme } from '../query/editorTheme';
import { sqlLanguage } from '../query/sqlLanguage';
import styles from './SqlView.module.css';

/** SQL shown, not edited: highlighted like the editor, selectable and copyable. */
export function SqlView({
  sql,
  engine,
  label,
  fill = false,
}: {
  sql: string;
  engine: Engine;
  label: string;
  /** Takes the room it is given instead of a height of its own (a tab body). */
  fill?: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: sql,
        extensions: [
          cspSafeEditor(),
          lineNumbers(),
          sqlLanguage(engine),
          sqlEditorTheme,
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label }),
        ],
      }),
    });
    return () => {
      view.destroy();
    };
  }, [sql, engine, label]);

  return <div ref={parentRef} className={fill ? `${styles.view} ${styles.fill}` : styles.view} />;
}
