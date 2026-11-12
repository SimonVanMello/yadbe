import { startingWith, type ConsoleOption, type ConsoleSuggestions } from './consoleCompletion';

/**
 * Completion of the Redis console (`redis-cli` lines): the command names the server knows, with
 * the number of arguments each takes, and the key names among the keys already scanned.
 */

/** A command of the server, as `COMMAND` lists it. */
export interface RedisCommandHint {
  /** Lower case. */
  name: string;
  /** The server's arity: the command's own name counts, negative means "at least". */
  arity: number;
}

export type RedisContext =
  | { kind: 'command'; from: number; prefix: string }
  | { kind: 'key'; from: number; prefix: string; command: string }
  | { kind: 'none' };

/** Commands whose first argument is not a key (or that have none). */
const NO_KEY_FIRST = new Set([
  'acl',
  'auth',
  'bgrewriteaof',
  'bgsave',
  'client',
  'cluster',
  'command',
  'config',
  'dbsize',
  'debug',
  'echo',
  'eval',
  'evalsha',
  'flushall',
  'flushdb',
  'function',
  'hello',
  'info',
  'keys',
  'lastsave',
  'latency',
  'memory',
  'module',
  'object',
  'ping',
  'publish',
  'quit',
  'randomkey',
  'role',
  'save',
  'scan',
  'script',
  'select',
  'slowlog',
  'subscribe',
  'time',
  'xgroup',
  'xinfo',
]);

/** Commands whose key comes after a subcommand: `OBJECT ENCODING key`, `MEMORY USAGE key`. */
const KEY_SECOND = new Set(['memory', 'object', 'xgroup', 'xinfo']);

/** Commands that take keys all along their arguments. */
const KEY_EVERY = new Set([
  'del',
  'exists',
  'mget',
  'pfcount',
  'sdiff',
  'sinter',
  'sunion',
  'touch',
  'unlink',
  'watch',
]);

/** Whether argument `index` (1 is the first after the command) of `command` is a key. */
export function isKeyArgument(command: string, index: number): boolean {
  if (KEY_EVERY.has(command)) return true;
  if (KEY_SECOND.has(command)) return index === 2;
  if (command === 'rename' || command === 'renamenx' || command === 'copy') return index <= 2;
  return index === 1 && !NO_KEY_FIRST.has(command);
}

/** The words of the line before the cursor, with an unfinished quote noted. */
function words(line: string): { done: string[]; typed: string; open: boolean } {
  const done: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote) {
      current += c;
      if (c === '\\' && quote === '"') {
        current += line.charAt(i + 1);
        i += 1;
      } else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
      current += c;
    } else if (/\s/.test(c)) {
      if (started) done.push(current);
      current = '';
      started = false;
    } else {
      started = true;
      current += c;
    }
  }
  return { done, typed: started ? current : '', open: quote !== null };
}

/** What is being typed at `position` in the console. */
export function redisContext(text: string, position: number): RedisContext {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const line = text.slice(lineStart, position);
  if (/^\s*#/.test(line)) return { kind: 'none' };
  const { done, typed, open } = words(line);
  if (open) return { kind: 'none' };
  const from = position - typed.length;
  const command = done[0]?.toLowerCase();
  if (command === undefined) return { kind: 'command', from, prefix: typed };
  return isKeyArgument(command, done.length)
    ? { kind: 'key', from, prefix: typed, command }
    : { kind: 'none' };
}

const needsQuotes = (key: string) => !/^[\x21-\x7e]+$/.test(key) || /["'\\]/.test(key);

/** What the server says about the arguments: `1` for exactly one, `1+` for at least one. */
function arityLabel(arity: number): string {
  const arguments_ = Math.abs(arity) - 1;
  return arity < 0 ? `${String(arguments_)}+` : String(arguments_);
}

export interface RedisData {
  commands: readonly RedisCommandHint[];
  /** The scanned keys that contain what is typed. */
  keys: readonly string[];
}

/** The suggestions for a context. */
export function redisOptions(
  context: RedisContext,
  data: RedisData,
  to: number,
): ConsoleSuggestions | null {
  if (context.kind === 'key') {
    // The backend matched the text anywhere in the key; the list shows them as found, and a key
    // that needs quoting is inserted quoted.
    const options = data.keys.map((key): ConsoleOption => ({
      label: key,
      apply: needsQuotes(key) ? `"${key.replace(/(["\\])/g, '\\$1')}"` : key,
      type: 'text',
    }));
    return options.length === 0 ? null : { from: context.from, to, options };
  }
  if (context.kind === 'none') return null;
  const options = data.commands.map((hint): ConsoleOption => ({
    label: hint.name.toUpperCase(),
    type: 'keyword',
    detail: arityLabel(hint.arity),
  }));
  const found = startingWith(options, context.prefix);
  return found.length === 0 ? null : { from: context.from, to, options: found };
}
