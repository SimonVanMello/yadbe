import { describe, expect, it } from 'vitest';

import { normalizeLineEndings, useFileIssues } from './fileIssues';

describe('normalizeLineEndings', () => {
  it('reads Windows and old Mac line breaks as the editor does', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('file issues', () => {
  it('is set and cleared per tab', () => {
    useFileIssues.getState().set('t1', { kind: 'missing' });
    useFileIssues.getState().set('t2', { kind: 'modified', diskText: 'x' });
    expect(Object.keys(useFileIssues.getState().issues)).toEqual(['t1', 't2']);
    useFileIssues.getState().set('t1', null);
    expect(Object.keys(useFileIssues.getState().issues)).toEqual(['t2']);
    useFileIssues.getState().set('t2', null);
  });
});
