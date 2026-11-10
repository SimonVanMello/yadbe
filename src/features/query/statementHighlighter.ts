import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';

import { ipc, unwrap, type Engine, type TextRange } from '../../ipc';
import { setStatement } from './editorFields';
import { StatementLookup, worthHighlighting } from './statementLookup';

/** Quiet time after a keystroke or cursor move before the statement under it is looked up. */
const LOOKUP_DELAY_MS = 120;

/**
 * Tints the statement under the cursor, the one `Mod+Shift+Enter` would run (F-041). The
 * lookup is the backend's `statementAt`, debounced and cached per document version
 * (`StatementLookup`); with a selection nothing is tinted, since the selection is what runs.
 */
export function statementHighlighter(getEngine: () => Engine): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly lookup = new StatementLookup();
      private timer: ReturnType<typeof setTimeout> | undefined;
      private version = 0;
      private lastEngine: Engine;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.lastEngine = getEngine();
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.version += 1;
        if (update.docChanged || update.selectionSet) this.schedule();
      }

      destroy(): void {
        this.destroyed = true;
        clearTimeout(this.timer);
      }

      private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.refresh();
        }, LOOKUP_DELAY_MS);
      }

      private show(range: TextRange | null): void {
        if (!this.destroyed) this.view.dispatch({ effects: setStatement.of(range) });
      }

      private async refresh(): Promise<void> {
        const { state } = this.view;
        const { main, ranges } = state.selection;
        if (ranges.length > 1 || !main.empty) {
          this.show(null);
          return;
        }
        const engine = getEngine();
        if (engine !== this.lastEngine) {
          // The same text splits differently under another dialect.
          this.lastEngine = engine;
          this.lookup.reset();
        }
        const version = this.version;
        const text = state.doc.toString();
        let found: TextRange | null;
        try {
          found = await this.lookup.at(version, main.head, () =>
            unwrap(ipc.commands.statementAt(engine, text, main.head)),
          );
        } catch {
          // The highlight is a courtesy: without it, running still works.
          found = null;
        }
        // The text moved on while the backend answered: the next lookup is already scheduled.
        if (this.destroyed || version !== this.version) return;
        this.show(found && worthHighlighting(found, text) ? found : null);
      }
    },
  );
}
