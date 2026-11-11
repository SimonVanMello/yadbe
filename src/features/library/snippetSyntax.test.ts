import { describe, expect, it } from 'vitest';

import { BUILTIN_TRIGGERS, builtinSnippetsFor } from './builtinSnippets';
import {
  expandVariables,
  flattenSnippet,
  hasPlaceholders,
  localDate,
  snippetFields,
  type SnippetContext,
} from './snippetSyntax';

const context: SnippetContext = { connection: 'shop · prod', database: 'shop', date: '2026-03-04' };

describe('snippet syntax', () => {
  it('replaces the variables and leaves the tab stops to the editor', () => {
    expect(
      expandVariables(
        '-- ${connection}/${database} on ${date}\nSELECT ${1:cols} FROM ${2}',
        context,
      ),
    ).toBe('-- shop · prod/shop on 2026-03-04\nSELECT ${1:cols} FROM ${2}');
  });

  it('leaves an unknown word between braces alone: the editor makes a tab stop of it', () => {
    expect(expandVariables('SELECT ${whatever}', context)).toBe('SELECT ${whatever}');
  });

  it('lists the numbered tab stops in visiting order, with their first default text', () => {
    expect(snippetFields('SELECT ${2:b}, ${1:a}, ${1}, ${3} FROM ${connection}')).toEqual([
      { index: 1, placeholder: 'a' },
      { index: 2, placeholder: 'b' },
      { index: 3, placeholder: '' },
    ]);
    expect(snippetFields('no fields here')).toEqual([]);
  });

  it('flattens a template into the text a query would send', () => {
    expect(
      flattenSnippet(
        'SELECT ${1:id}\nFROM ${2:table}\nWHERE ${1} > 0 -- ${date} ${nothing} ${3}',
        context,
      ),
    ).toBe('SELECT id\nFROM table\nWHERE id > 0 -- 2026-03-04 nothing ');
  });

  it('leaves text without fields untouched, dollar quoting included', () => {
    const sql = "SELECT $1, $$body$$ FROM t WHERE a = '$'";
    expect(flattenSnippet(sql, context)).toBe(sql);
    expect(expandVariables(sql, context)).toBe(sql);
    expect(hasPlaceholders(sql)).toBe(false);
    expect(hasPlaceholders('SELECT ${1}')).toBe(true);
    expect(hasPlaceholders('-- ${date}')).toBe(true);
  });

  it('writes the local date with two digits', () => {
    expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(localDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('built-in snippets', () => {
  it('give each dialect its own forms', () => {
    const top = (engine: 'postgres' | 'mssql') =>
      builtinSnippetsFor(engine).find((snippet) => snippet.trigger === 'selt')?.template;
    expect(top('postgres')).toContain('LIMIT');
    expect(top('mssql')).toContain('TOP');
    const plan = (engine: 'postgres' | 'sqlite' | 'mysql' | 'mssql') =>
      builtinSnippetsFor(engine).find((snippet) => snippet.trigger === 'expl')?.template;
    expect(plan('postgres')).toContain('BUFFERS');
    expect(plan('sqlite')).toContain('QUERY PLAN');
    expect(plan('mysql')).toContain('EXPLAIN ANALYZE');
    expect(plan('mssql')).toBeUndefined();
  });

  it('have unique trigger words made of letters, with valid tab stops', () => {
    expect(new Set(BUILTIN_TRIGGERS).size).toBe(BUILTIN_TRIGGERS.length);
    for (const engine of ['postgres', 'mssql', 'mysql', 'sqlite'] as const) {
      for (const snippet of builtinSnippetsFor(engine)) {
        expect(snippet.trigger).toMatch(/^[a-z]+$/);
        expect(snippetFields(snippet.template).length).toBeGreaterThan(0);
        // Nothing is left for the editor to read as a variable by mistake.
        expect(flattenSnippet(snippet.template, context)).not.toContain('${');
      }
    }
  });
});
