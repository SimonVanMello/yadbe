import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

import type { Engine } from '../../ipc';
import { styleNonce } from '../../ui/cspNonce';
import { sqlEditorTheme } from '../query/editorTheme';
import { sqlLanguage } from '../query/sqlLanguage';
import styles from './SqlView.module.css';

/** SQL shown, not edited: highlighted like the editor, selectable and copyable. */
export function SqlView({ sql, engine, label }: { sql: string; engine: Engine; label: string }) {
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;
    const nonce = styleNonce();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: sql,
        extensions: [
          // CodeMirror injects `<style>` tags: they need the page's nonce outside `tauri dev`.
          nonce === null ? [] : EditorView.cspNonce.of(nonce),
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

  return <div ref={parentRef} className={styles.view} />;
}
