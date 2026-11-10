import { describe, expect, it } from 'vitest';

import { runLabelKey, scopeFor, selectedRange } from './runScope';

const text = 'select 1;\nselect 2;';
const caret = (offset: number) => ({ anchor: offset, head: offset });

describe('scopeFor', () => {
  it('runs everything without a selection', () => {
    expect(scopeFor('auto', caret(3), text)).toEqual({ kind: 'all' });
    expect(scopeFor('all', caret(3), text)).toEqual({ kind: 'all' });
  });

  it('runs the selection when there is one, whichever way it was drawn', () => {
    expect(scopeFor('auto', { anchor: 10, head: 19 }, text)).toEqual({
      kind: 'range',
      from: 10,
      to: 19,
    });
    expect(scopeFor('selection', { anchor: 19, head: 10 }, text)).toEqual({
      kind: 'range',
      from: 10,
      to: 19,
    });
  });

  it('"all" ignores the selection', () => {
    expect(scopeFor('all', { anchor: 10, head: 19 }, text)).toEqual({ kind: 'all' });
  });

  it('refuses a selection run without anything selected', () => {
    expect(scopeFor('selection', caret(4), text)).toBeNull();
    expect(scopeFor('selection', { anchor: 9, head: 10 }, text)).toBeNull();
  });

  it('falls back to the whole script when the selection is only blank', () => {
    expect(scopeFor('auto', { anchor: 9, head: 10 }, text)).toEqual({ kind: 'all' });
  });

  it('runs the statement at the cursor head', () => {
    expect(scopeFor('statement', { anchor: 2, head: 14 }, text)).toEqual({
      kind: 'statementAt',
      offset: 14,
    });
    expect(scopeFor('statement', caret(500), text)).toEqual({
      kind: 'statementAt',
      offset: text.length,
    });
  });

  it('has nothing to run in an empty script', () => {
    expect(scopeFor('all', caret(0), '  \n')).toBeNull();
    expect(scopeFor('statement', caret(0), '')).toBeNull();
  });
});

describe('selectedRange and the Run label', () => {
  it('is null for a caret', () => {
    expect(selectedRange(caret(5))).toBeNull();
  });

  it('names what the Run button runs', () => {
    expect(runLabelKey(caret(5))).toBe('toolbar.run');
    expect(runLabelKey({ anchor: 1, head: 4 })).toBe('toolbar.runSelection');
  });
});
