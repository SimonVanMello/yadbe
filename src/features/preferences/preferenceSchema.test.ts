import { describe, expect, it } from 'vitest';

import {
  BACKEND_KEYS,
  DEFINITIONS,
  PREFERENCES_VERSION,
  PREFERENCE_KEYS,
  UI_KEYS,
  backendValues,
  defaultOf,
  defaultValues,
  hasSavedUiPreferences,
  normalize,
  readUiPreferences,
  toBackend,
  writeUiPreferences,
} from './preferenceSchema';

describe('the defaults', () => {
  it('match what the app did before the screen existed', () => {
    const defaults = defaultValues();
    expect(defaults).toMatchObject({
      theme: 'system',
      density: 'comfortable',
      confirmDangerous: true,
      completeAsYouType: true,
      tabSize: 2,
      indentWithSpaces: true,
      lineNumbers: true,
      resultMaxRows: 100_000,
      resultMaxMb: 256,
      defaultPageSize: 500,
      nullText: 'NULL',
      historyMaxEntries: 50_000,
      historyMaxAgeDays: 365,
      connectTimeoutSecs: 15,
    });
  });

  it('are valid for their own definition', () => {
    for (const key of PREFERENCE_KEYS) {
      expect(DEFINITIONS[key].parse(defaultOf(key))).toEqual(defaultOf(key));
    }
  });
});

describe('normalizing a value', () => {
  it('clamps numbers into their range and rounds them', () => {
    expect(normalize('uiFontSize', 99)).toBe(18);
    expect(normalize('uiFontSize', 1)).toBe(11);
    expect(normalize('resultMaxRows', 12_345.6)).toBe(12_346);
  });

  it('falls back to the default for the wrong type or an unknown choice', () => {
    expect(normalize('uiFontSize', 'big')).toBe(13);
    expect(normalize('density', 'huge')).toBe('comfortable');
    expect(normalize('tabSize', 3)).toBe(2);
    expect(normalize('defaultPageSize', 750)).toBe(500);
    expect(normalize('lineNumbers', 'yes')).toBe(true);
  });

  it('refuses a font family that could break out of a CSS declaration', () => {
    expect(normalize('editorFontFamily', 'Fira Code, monospace')).toBe('Fira Code, monospace');
    expect(normalize('editorFontFamily', 'x; background: url(//evil)')).toBe('');
    expect(normalize('gridFontFamily', '  Menlo  ')).toBe('Menlo');
  });

  it('does not accept an empty NULL text', () => {
    expect(normalize('nullText', '   ')).toBe('NULL');
    expect(normalize('nullText', '∅')).toBe('∅');
  });
});

describe('the saved frontend slice', () => {
  it('reads known keys, drops unknown ones and fixes invalid ones', () => {
    const read = readUiPreferences(
      {
        version: 1,
        values: { tabSize: 4, lineWrapping: true, uiFontSize: 400, nothing: 'here', nullText: 7 },
      },
      null,
    );
    expect(read.tabSize).toBe(4);
    expect(read.lineWrapping).toBe(true);
    expect(read.nullText).toBe('NULL');
    expect(read).not.toHaveProperty('nothing');
    expect(Object.keys(read).sort()).toEqual([...UI_KEYS].sort());
  });

  it('never returns the keys the backend or the theme store own', () => {
    const read = readUiPreferences(
      { version: 1, values: { theme: 'dark', density: 'compact' } },
      null,
    );
    expect(read).not.toHaveProperty('theme');
    expect(read).not.toHaveProperty('density');
    expect(read).not.toHaveProperty('historyMaxEntries');
  });

  it('migrates the two settings the old `query` slice held, when there is no slice yet', () => {
    const read = readUiPreferences(undefined, {
      resultsRatio: 0.5,
      confirmDangerous: false,
      completeAsYouType: false,
    });
    expect(read.confirmDangerous).toBe(false);
    expect(read.completeAsYouType).toBe(false);
    expect(read.tabSize).toBe(2);
  });

  it('ignores the old slice once the new one exists', () => {
    const read = readUiPreferences({ version: 1, values: {} }, { confirmDangerous: false });
    expect(read.confirmDangerous).toBe(true);
  });

  it('tolerates garbage', () => {
    for (const garbage of [null, 'x', 4, [], { values: 'no' }]) {
      expect(readUiPreferences(garbage, garbage)).toEqual(readUiPreferences(undefined, undefined));
    }
  });

  it('is written with its version and only the frontend keys', () => {
    const written = writeUiPreferences({ ...defaultValues(), tabSize: 8, density: 'compact' });
    expect(written.version).toBe(PREFERENCES_VERSION);
    expect(Object.keys(written.values).sort()).toEqual([...UI_KEYS].sort());
    expect(written.values.tabSize).toBe(8);
    expect(hasSavedUiPreferences(written)).toBe(true);
    expect(hasSavedUiPreferences(undefined)).toBe(false);
  });

  it('round-trips through write and read', () => {
    const values = { ...defaultValues(), lineWrapping: true, resultMaxMb: 512, nullText: '∅' };
    expect(readUiPreferences(writeUiPreferences(values), null)).toEqual(
      Object.fromEntries(UI_KEYS.map((key) => [key, values[key]])),
    );
  });
});

describe('the backend record', () => {
  const backend = {
    theme: 'dark' as const,
    locale: 'fr' as const,
    density: 'compact' as const,
    uiState: '{}',
    historyEnabled: false,
    historyMaxEntries: 1000,
    historyMaxAgeDays: 30,
    connectTimeoutSecs: 45,
    journalMaxEntries: 500,
    journalMaxAgeDays: 7,
  };

  it('feeds the settings the backend stores', () => {
    expect(backendValues(backend)).toEqual({
      density: 'compact',
      historyEnabled: false,
      historyMaxEntries: 1000,
      historyMaxAgeDays: 30,
      connectTimeoutSecs: 45,
      journalMaxEntries: 500,
      journalMaxAgeDays: 7,
    });
    expect(Object.keys(backendValues(backend)).sort()).toEqual([...BACKEND_KEYS].sort());
  });

  it('is rebuilt from the settings without touching the rest of it', () => {
    const values = { ...defaultValues(), historyMaxEntries: 200, connectTimeoutSecs: 5 };
    expect(toBackend(backend, values)).toEqual({
      ...backend,
      density: 'comfortable',
      historyEnabled: true,
      historyMaxEntries: 200,
      historyMaxAgeDays: 365,
      connectTimeoutSecs: 5,
      journalMaxEntries: 1000,
      journalMaxAgeDays: 90,
    });
  });
});
