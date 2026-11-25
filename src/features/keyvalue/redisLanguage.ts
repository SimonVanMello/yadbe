import { StreamLanguage } from '@codemirror/language';

/**
 * `redis-cli` lines, coloured: the command name, quoted arguments, numbers and `#` comments.
 * Colour only: the backend splits the lines (its tokenizer is the one that counts).
 */
export const redisCli = StreamLanguage.define<{ start: boolean }>({
  startState: () => ({ start: true }),
  token(stream, state) {
    if (stream.sol()) state.start = true;
    if (stream.eatSpace()) return null;
    if (state.start && stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      let escaped = false;
      for (;;) {
        const ch = stream.next();
        if (ch === undefined) break;
        if (ch === quote && !escaped) break;
        escaped = !escaped && ch === '\\' && quote === '"';
      }
      state.start = false;
      return 'string';
    }
    stream.eatWhile(/\S/);
    const word = stream.current();
    if (state.start) {
      state.start = false;
      return 'keyword';
    }
    return /^-?\d+(\.\d+)?$/.test(word) ? 'number' : null;
  },
});
