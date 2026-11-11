import { snippet } from '@codemirror/autocomplete';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import type { SnippetDefinition } from '../../ipc';
import { offeredSnippets, matchingSnippets } from './snippetCompletion';
import { expandVariables } from './snippetSyntax';

const user = (patch: Partial<SnippetDefinition>): SnippetDefinition => ({
  id: 'u1',
  name: 'Mine',
  trigger: 'mine',
  template: 'SELECT ${1:a}',
  description: '',
  connectionId: null,
  database: null,
  ...patch,
});

const nameOf = (key: string) => key;

describe('offered snippets', () => {
  it('keeps the global snippets and the connection’s, not another connection’s', () => {
    const offered = offeredSnippets(
      [
        user({ id: 'g', trigger: 'glob' }),
        user({ id: 'p', trigger: 'pgonly', connectionId: 'pg' }),
        user({ id: 'm', trigger: 'sqlonly', connectionId: 'mssql' }),
      ],
      'pg',
      'postgres',
      nameOf,
    );
    const own = offered.filter((s) => !s.builtin).map((s) => s.trigger);
    expect(own).toEqual(['glob', 'pgonly']);
  });

  it('adds the built-ins of the dialect, except where a user snippet takes the trigger word', () => {
    const offered = offeredSnippets(
      [user({ id: 'x', trigger: 'selt', template: 'SELECT 42' })],
      null,
      'postgres',
      nameOf,
    );
    const selt = offered.filter((s) => s.trigger === 'selt');
    expect(selt).toHaveLength(1);
    expect(selt[0]).toMatchObject({ builtin: false, template: 'SELECT 42' });
    expect(offered.some((s) => s.builtin && s.trigger === 'cnt')).toBe(true);
    expect(offered.some((s) => s.builtin && s.trigger === 'expl')).toBe(true);
    const mssql = offeredSnippets([], null, 'mssql', nameOf);
    expect(mssql.some((s) => s.trigger === 'expl')).toBe(false);
    expect(mssql.find((s) => s.trigger === 'selt')?.template).toContain('TOP');
  });
});

describe('matching a trigger word', () => {
  const offered = offeredSnippets(
    [user({ id: 'a', trigger: 'sel_mine' }), user({ id: 'b', trigger: 'Selx' })],
    null,
    'postgres',
    nameOf,
  );

  it('matches by prefix, whatever the case, the exact word first, the user’s before built-ins', () => {
    const triggers = matchingSnippets(offered, 'sel').map((s) => s.trigger);
    expect(triggers).toEqual(['sel_mine', 'Selx', 'selt']);
    expect(matchingSnippets(offered, 'selx').map((s) => s.trigger)).toEqual(['Selx']);
    expect(matchingSnippets(offered, 'selt').map((s) => s.trigger)).toEqual(['selt']);
    expect(matchingSnippets(offered, 'SELT').map((s) => s.trigger)).toEqual(['selt']);
  });

  it('puts the exact trigger word before longer ones', () => {
    const more = offeredSnippets([user({ id: 'c', trigger: 'cntx' })], null, 'postgres', nameOf);
    expect(matchingSnippets(more, 'cnt').map((s) => s.trigger)).toEqual(['cnt', 'cntx']);
  });

  it('finds nothing for an empty or unknown word', () => {
    expect(matchingSnippets(offered, '')).toEqual([]);
    expect(matchingSnippets(offered, 'zzz')).toEqual([]);
  });
});

describe('expanding in a real editor', () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it('replaces the typed word with the template, variables resolved, first field selected', () => {
    const state = EditorState.create({
      doc: 'select 1;\nlast',
      selection: EditorSelection.cursor(14),
    });
    view = new EditorView({ state, parent: document.body });
    const template = expandVariables('SELECT ${1:cols}\nFROM ${2:table}\n-- ${database} ${date}', {
      connection: 'c',
      database: 'shop',
      date: '2026-03-04',
    });
    snippet(template)(view, null, 10, 14);
    expect(view.state.doc.toString()).toBe(
      'select 1;\nSELECT cols\nFROM table\n-- shop 2026-03-04',
    );
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe('cols');
  });
});
