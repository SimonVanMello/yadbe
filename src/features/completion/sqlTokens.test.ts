import { describe, expect, it } from 'vitest';

import { insideLiteral, tokenize, type QuoteRules } from './sqlTokens';

const PG: QuoteRules = { open: '"', close: '"' };
const MSSQL: QuoteRules = { open: '[', close: ']' };
const MYSQL: QuoteRules = { open: '`', close: '`' };

const kinds = (sql: string, rules = PG) =>
  tokenize(sql, rules).map((t) => `${t.kind}:${sql.slice(t.from, t.to)}`);

describe('tokenize', () => {
  it('splits words, punctuation and numbers', () => {
    expect(kinds('select a.b, 12 from t;')).toEqual([
      'word:select',
      'word:a',
      'punct:.',
      'word:b',
      'punct:,',
      'number:12',
      'word:from',
      'word:t',
      'punct:;',
    ]);
  });

  it('keeps `::` together, and `$1` as a parameter', () => {
    expect(kinds('a::int $1')).toEqual(['word:a', 'punct:::', 'word:int', 'param:$1']);
  });

  it('reads strings with doubled quotes, closed or not', () => {
    const [closed] = tokenize("'it''s'", PG);
    expect(closed).toMatchObject({ kind: 'string', closed: true, to: 7 });
    expect(tokenize("'abc", PG)[0]).toMatchObject({ kind: 'string', closed: false, to: 4 });
  });

  it('reads dollar-quoted strings with their tag', () => {
    expect(kinds('$$ a; $$ b')).toEqual(['string:$$ a; $$', 'word:b']);
    expect(kinds('$f$ $$ $f$ x')).toEqual(['string:$f$ $$ $f$', 'word:x']);
    expect(tokenize('$$ open', PG)[0]).toMatchObject({ kind: 'string', closed: false });
  });

  it('reads comments, line and block', () => {
    const tokens = tokenize('a -- x\nb /* y */ c', PG);
    expect(tokens.map((t) => t.kind)).toEqual(['word', 'comment', 'word', 'comment', 'word']);
    expect(tokens[1]).toMatchObject({ line: true });
    expect(tokens[1]?.to).toBe(6);
    expect(tokenize('/* open', PG)[0]).toMatchObject({ kind: 'comment', closed: false });
  });

  it('reads quoted names per dialect, undoing doubled closing quotes', () => {
    expect(tokenize('"a ""b"""', PG)[0]).toMatchObject({ kind: 'quoted', value: 'a "b"' });
    expect(tokenize('[a ]]b]', MSSQL)[0]).toMatchObject({ kind: 'quoted', value: 'a ]b' });
    expect(tokenize('`a b`', MYSQL)[0]).toMatchObject({ kind: 'quoted', value: 'a b' });
    expect(tokenize('"abc', PG)[0]).toMatchObject({ kind: 'quoted', closed: false, value: 'abc' });
  });

  it('accepts double quotes as quoted names on SQL Server, as strings on MySQL', () => {
    expect(tokenize('"x y"', MSSQL)[0]?.kind).toBe('quoted');
    expect(tokenize('"x y"', MYSQL)[0]?.kind).toBe('string');
  });

  it('does not take brackets for quotes where they are not (Postgres arrays)', () => {
    expect(kinds('a[1]')).toEqual(['word:a', 'punct:[', 'number:1', 'punct:]']);
  });

  it('knows letters of any alphabet and SQL Server temp tables', () => {
    expect(kinds('prénom #tmp @v')).toEqual(['word:prénom', 'word:#tmp', 'word:@v']);
  });

  it('lower-cases the words for keyword tests', () => {
    expect(tokenize('SeLeCt', PG)[0]).toMatchObject({ value: 'SeLeCt', lower: 'select' });
  });
});

describe('insideLiteral', () => {
  it('is true strictly inside a string, and up to the end of a line comment', () => {
    const [string] = tokenize("'abc'", PG);
    expect(string && insideLiteral(string, 0)).toBe(false);
    expect(string && insideLiteral(string, 1)).toBe(true);
    expect(string && insideLiteral(string, 4)).toBe(true);
    expect(string && insideLiteral(string, 5)).toBe(false);
    const [comment] = tokenize('-- abc', PG);
    expect(comment && insideLiteral(comment, 6)).toBe(true);
    expect(comment && insideLiteral(comment, 0)).toBe(false);
  });

  it('is true to the end of an unterminated string', () => {
    const [string] = tokenize("'abc", PG);
    expect(string && insideLiteral(string, 4)).toBe(true);
  });
});
