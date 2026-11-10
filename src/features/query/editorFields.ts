import { ChangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import type { TextRange } from '../../ipc';

const STATEMENT = Decoration.mark({ class: 'cm-statement-highlight' });
const ERROR = Decoration.mark({ class: 'cm-error-range' });

function clampRange(range: TextRange, length: number): TextRange | null {
  const from = Math.max(0, Math.min(range.from, length));
  const to = Math.max(from, Math.min(range.to, length));
  return to > from ? { from, to } : null;
}

/** The statement about to run, tinted (F-041). `null` clears it. */
export const setStatement = StateEffect.define<TextRange | null>();

const statementField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setStatement)) {
        const range = effect.value && clampRange(effect.value, tr.state.doc.length);
        return range ? Decoration.set([STATEMENT.range(range.from, range.to)]) : Decoration.none;
      }
    }
    // A stale highlight is worse than none: an edit clears it until the next lookup answers.
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Remembers the document as it was when a run started, to follow offsets through later edits. */
export const markRun = StateEffect.define();

const runChanges = StateField.define<ChangeSet | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(markRun)) return ChangeSet.empty(tr.state.doc.length);
    }
    return value && tr.docChanged ? value.compose(tr.changes) : value;
  },
});

/** Underlines spans of the document (positions as they were when the run started). */
export const setErrors = StateEffect.define<readonly TextRange[]>();

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrors)) {
        const changes = tr.state.field(runChanges, false);
        const ranges = effect.value.flatMap((range) => {
          const mapped = changes
            ? { from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1) }
            : range;
          const clamped = clampRange(mapped, tr.state.doc.length);
          return clamped ? [ERROR.range(clamped.from, clamped.to)] : [];
        });
        return Decoration.set(ranges, true);
      }
    }
    return value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Where an offset of the text a run started with is now, after the edits made since. */
export function currentOffset(view: EditorView, offset: number): number {
  const changes = view.state.field(runChanges, false);
  const mapped = changes ? changes.mapPos(offset, 1) : offset;
  return Math.max(0, Math.min(mapped, view.state.doc.length));
}

/** The statement highlight and the error underlines. */
export const queryFields: Extension = [statementField, runChanges, errorField];
