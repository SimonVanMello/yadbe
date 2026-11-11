import {
  CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { withSnippets } from './snippetCompletion';

const result = (from: number, labels: string[]): CompletionResult => ({
  from,
  options: labels.map((label) => ({ label })),
});

const source =
  (value: CompletionResult | null): CompletionSource =>
  () =>
    value;

async function run(typed: string, sql: CompletionResult | null, snippets: CompletionResult | null) {
  const state = EditorState.create({ doc: typed });
  const context = new CompletionContext(state, typed.length, true);
  const merged = await withSnippets(source(sql), source(snippets))(context);
  return merged?.options.map((option) => option.label);
}

describe('snippets next to the SQL suggestions', () => {
  it('come after them, so Tab on a prefix still gives the keyword', async () => {
    expect(await run('sel', result(0, ['select']), result(0, ['selt']))).toEqual([
      'select',
      'selt',
    ]);
  });

  it('lead when the typed word is exactly their trigger', async () => {
    expect(await run('selt', result(0, ['select']), result(0, ['selt']))).toEqual([
      'selt',
      'select',
    ]);
  });

  it('keep whichever source answered, or the SQL one when they start apart', async () => {
    expect(await run('x', null, result(0, ['x1']))).toEqual(['x1']);
    expect(await run('x', result(0, ['x2']), null)).toEqual(['x2']);
    expect(await run('x', result(0, ['x2']), result(1, ['x1']))).toEqual(['x2']);
    expect(await run('x', null, null)).toBeUndefined();
  });
});
