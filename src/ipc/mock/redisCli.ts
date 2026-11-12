/**
 * Mirror of `db::keyvalue::tokenize` and `command::display` for the mock: a console line split
 * the way `redis-cli` does it, and a command written back for the history, secrets redacted.
 * Arguments are kept as strings of code points 0–255 for raw bytes (`\xff`), else as text.
 */

export class UnbalancedQuotes extends Error {}

/** The arguments of one line; an empty line has none. */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  const n = line.length;
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  for (;;) {
    while (i < n && isSpace(line[i])) i++;
    if (i >= n) return args;
    let current = '';
    let inDouble = false;
    let inSingle = false;
    let started = false;
    for (;;) {
      const c = line[i];
      if (inDouble) {
        if (c === undefined) throw new UnbalancedQuotes();
        const hex = /^\\x([0-9a-fA-F]{2})/.exec(line.slice(i, i + 4));
        if (hex?.[1]) {
          current += String.fromCharCode(parseInt(hex[1], 16));
          i += 4;
          continue;
        }
        if (c === '\\' && i + 1 < n) {
          const next = line[i + 1] ?? '';
          const escapes: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            b: '\b',
            a: '\u0007',
          };
          current += escapes[next] ?? next;
          i += 2;
          continue;
        }
        if (c === '"') {
          if (i + 1 < n && !isSpace(line[i + 1])) throw new UnbalancedQuotes();
          i++;
          break;
        }
        current += c;
        i++;
      } else if (inSingle) {
        if (c === undefined) throw new UnbalancedQuotes();
        if (c === '\\' && line[i + 1] === "'") {
          current += "'";
          i += 2;
          continue;
        }
        if (c === "'") {
          if (i + 1 < n && !isSpace(line[i + 1])) throw new UnbalancedQuotes();
          i++;
          break;
        }
        current += c;
        i++;
      } else {
        if (c === undefined || isSpace(c)) break;
        if (c === '"' && !started) inDouble = true;
        else if (c === "'" && !started) inSingle = true;
        else current += c;
        started = true;
        i++;
      }
    }
    args.push(current);
  }
}

/** The command lines of a console text, with their 0-based line numbers. */
export function commandLines(text: string): { line: number; text: string }[] {
  return text
    .split('\n')
    .map((raw, line) => ({ line, text: raw.trim() }))
    .filter((entry) => entry.text !== '' && !entry.text.startsWith('#'));
}

function escape(arg: string): string {
  let out = '';
  for (const ch of arg) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0xff))
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

/** One argument as `redis-cli` would need it typed. */
export function quote(arg: string): string {
  return /^[!#-&(-[\]-~]+$/.test(arg) ? arg : `"${escape(arg)}"`;
}

const SECRET_SETTINGS = new Set([
  'requirepass',
  'masterauth',
  'masteruser',
  'tls-key-file-pass',
  'tls-client-key-file-pass',
]);

/** The command as a `redis-cli` line, its secrets replaced by `***`. */
export function displayCommand(args: readonly string[]): string {
  const name = (args[0] ?? '').toLowerCase();
  const lower = (i: number) => (args[i] ?? '').toLowerCase();
  const secrets = new Set<number>();
  if (name === 'auth' && args.length >= 2) secrets.add(args.length - 1);
  if (name === 'hello') args.forEach((_, i) => lower(i) === 'auth' && secrets.add(i + 2));
  if (name === 'migrate')
    args.forEach((_, i) => {
      if (lower(i) === 'auth') secrets.add(i + 1);
      if (lower(i) === 'auth2') secrets.add(i + 2);
    });
  if (name === 'acl' && lower(1) === 'setuser')
    args.forEach((arg, i) => i >= 3 && /^[><#!]/.test(arg) && secrets.add(i));
  if (name === 'config' && lower(1) === 'set')
    for (let i = 2; i + 1 < args.length; i += 2)
      if (SECRET_SETTINGS.has(lower(i))) secrets.add(i + 1);
  return args
    .map((arg, i) => {
      if (!secrets.has(i)) return quote(arg);
      return name === 'acl' && /^[><#!]/.test(arg) ? `${arg.charAt(0)}***` : '***';
    })
    .join(' ');
}

/** `redis-cli`'s glob of `SCAN … MATCH` as a regular expression. */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '*') source += '.*';
    else if (c === '?') source += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) source += '\\[';
      else {
        let set = pattern.slice(i + 1, end);
        if (set.startsWith('^')) set = `^${set.slice(1)}`;
        source += `[${set.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < pattern.length) {
      source += `\\${pattern[i + 1] ?? ''}`;
      i++;
    } else source += c.replace(/[.+^${}()|]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 's');
}
