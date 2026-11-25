import { StreamLanguage } from '@codemirror/language';

interface ConsoleState {
  /** On a request line: after the method. */
  afterMethod: boolean;
}

const METHOD = /^(GET|POST|PUT|DELETE|HEAD|PATCH)\b/i;

/**
 * Kibana's console syntax, coloured: the method and path of a request line, then JSON (keys,
 * strings, numbers, literals) and `#` / `//` comment lines. Colour only: the backend reads the
 * requests.
 */
export const consoleSyntax = StreamLanguage.define<ConsoleState>({
  startState: () => ({ afterMethod: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.afterMethod = false;
      if (stream.match(/^\s*(#|\/\/).*/)) return 'comment';
      if (stream.match(METHOD)) {
        state.afterMethod = true;
        return 'keyword';
      }
    }
    if (stream.eatSpace()) return null;
    if (state.afterMethod) {
      stream.skipToEnd();
      return 'link';
    }
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
      // A string followed by a colon is a key.
      return stream.match(/^\s*:/, false) ? 'propertyName' : 'string';
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/^(true|false|null)\b/)) return 'atom';
    stream.next();
    return null;
  },
  languageData: { closeBrackets: { brackets: ['{', '[', '"'] } },
});
