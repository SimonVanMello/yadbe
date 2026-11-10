import { describe, expect, it } from 'vitest';

import { MOCK_ENGINES } from '../../ipc/mockData';
import { needsQuotes, quote, quoteIfNeeded, quotingOf } from './identifierQuoting';

const capabilities = (engine: string) => {
  const info = MOCK_ENGINES.find((e) => e.engine === engine);
  if (!info) throw new Error(engine);
  return quotingOf(info.capabilities);
};

const pg = capabilities('postgres');
const mssql = capabilities('mssql');
const mysql = capabilities('mysql');
const sqlite = capabilities('sqlite');

describe('when a name needs quotes', () => {
  it('not for plain lower-case names', () => {
    for (const name of ['orders', 'order_items', '_x', 'a1', 'created_at', 'col$1']) {
      expect(needsQuotes(name, pg)).toBe(false);
    }
  });

  it('for spaces, punctuation, a leading digit', () => {
    for (const name of ['Order Notes', 'a-b', '1abc', 'a.b', 'a"b', '']) {
      expect(needsQuotes(name, pg)).toBe(true);
      expect(needsQuotes(name, mssql)).toBe(true);
    }
  });

  it('for reserved words, on every engine', () => {
    for (const name of ['select', 'Order', 'GROUP', 'user', 'table']) {
      expect(needsQuotes(name, sqlite)).toBe(true);
      expect(needsQuotes(name, mysql)).toBe(true);
    }
    expect(needsQuotes('status', pg)).toBe(false);
  });

  it('for capitals only where the engine folds unquoted names to lower case', () => {
    expect(needsQuotes('Customers', pg)).toBe(true);
    expect(needsQuotes('Customers', mssql)).toBe(false);
    expect(needsQuotes('Customers', mysql)).toBe(false);
    expect(needsQuotes('Customers', sqlite)).toBe(false);
  });

  it('not for accented letters', () => {
    expect(needsQuotes('prénom', pg)).toBe(false);
  });
});

describe('writing a name', () => {
  it('quotes with the dialect`s characters and doubles the closing one', () => {
    expect(quote('a b', pg)).toBe('"a b"');
    expect(quote('a"b', pg)).toBe('"a""b"');
    expect(quote('a b', mssql)).toBe('[a b]');
    expect(quote('a]b', mssql)).toBe('[a]]b]');
    expect(quote('a b', mysql)).toBe('`a b`');
    expect(quote('a`b', mysql)).toBe('`a``b`');
    expect(quote('a b', sqlite)).toBe('"a b"');
  });

  it('leaves plain names alone', () => {
    expect(quoteIfNeeded('orders', pg)).toBe('orders');
    expect(quoteIfNeeded('Order Notes', mssql)).toBe('[Order Notes]');
    expect(quoteIfNeeded('Select', mysql)).toBe('`Select`');
  });

  it('agrees with what the backend says about each engine', () => {
    const open = (engine: string) => capabilities(engine).open;
    expect([open('postgres'), open('mssql'), open('mysql'), open('sqlite')]).toEqual([
      '"',
      '[',
      '`',
      '"',
    ]);
  });
});
