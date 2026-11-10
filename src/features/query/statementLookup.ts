import type { TextRange } from '../../ipc';

const MAX_CACHED_OFFSETS = 256;

/**
 * Answers "which statement is under this offset" for one editor, asking the backend's splitter
 * (`statementAt`) as little as possible: answers are kept per document version, and an offset
 * inside a statement already found needs no new question.
 */
export class StatementLookup {
  private version = -1;
  private known: TextRange[] = [];
  private byOffset = new Map<number, TextRange | null>();

  /** `fetch` asks the backend; it only runs when the cache cannot answer. */
  async at(
    version: number,
    offset: number,
    fetch: () => Promise<TextRange | null>,
  ): Promise<TextRange | null> {
    if (version !== this.version) {
      this.version = version;
      this.known = [];
      this.byOffset.clear();
    }
    const inside = this.known.find((range) => offset >= range.from && offset <= range.to);
    if (inside) return inside;
    if (this.byOffset.has(offset)) return this.byOffset.get(offset) ?? null;
    const found = await fetch();
    // The document may have moved on while the backend answered: keep nothing from a stale answer.
    if (version !== this.version) return found;
    if (this.byOffset.size >= MAX_CACHED_OFFSETS) this.byOffset.clear();
    this.byOffset.set(offset, found);
    if (found && !this.known.some((range) => range.from === found.from && range.to === found.to)) {
      this.known.push(found);
    }
    return found;
  }

  /** Forgets everything (the engine changed: the same text splits differently). */
  reset(): void {
    this.version = -1;
    this.known = [];
    this.byOffset.clear();
  }
}

/**
 * Whether tinting the statement helps: not when it is the whole script (nothing to tell it
 * from), which would only paint the editor.
 */
export function worthHighlighting(range: TextRange, text: string): boolean {
  const before = text.slice(0, range.from);
  const after = text.slice(range.to);
  return before.trim() !== '' || after.replace(/[;\s]/g, '') !== '';
}
