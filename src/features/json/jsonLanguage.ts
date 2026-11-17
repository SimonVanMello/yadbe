import { StreamLanguage } from '@codemirror/language';

interface JsonState {
  /** Brackets open at this point: the indentation of the next line. */
  depth: number;
}

/**
 * JSON for CodeMirror: keys, strings, numbers, literals and punctuation coloured; `{`, `[` and
 * `"` closed as they are typed; a new line indented by the brackets open above it. Colour and
 * typing help only: the text is read by the caller's own parser (Extended JSON, `_source`…),
 * so this tokenizer never rejects anything.
 */
export const jsonLanguage = StreamLanguage.define<JsonState>({
  name: 'json',
  startState: () => ({ depth: 0 }),
  copyState: (state) => ({ depth: state.depth }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    const ch = stream.peek();
    if (ch === '"') {
      stream.next();
      let escaped = false;
      for (;;) {
        const next = stream.next();
        if (next === undefined) break;
        if (next === '"' && !escaped) break;
        escaped = !escaped && next === '\\';
      }
      return stream.match(/^\s*:/, false) ? 'propertyName' : 'string';
    }
    if (ch === '{' || ch === '[') {
      stream.next();
      state.depth += 1;
      return 'bracket';
    }
    if (ch === '}' || ch === ']') {
      stream.next();
      state.depth = Math.max(0, state.depth - 1);
      return 'bracket';
    }
    if (ch === ':' || ch === ',') {
      stream.next();
      return 'punctuation';
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/^(true|false|null)\b/)) return 'atom';
    stream.next();
    return null;
  },
  indent(state, textAfter, context) {
    const closing = /^\s*[}\]]/.test(textAfter) ? 1 : 0;
    return Math.max(0, state.depth - closing) * context.unit;
  },
  languageData: {
    closeBrackets: { brackets: ['{', '[', '"'] },
    indentOnInput: /^\s*[}\]]$/,
  },
});
