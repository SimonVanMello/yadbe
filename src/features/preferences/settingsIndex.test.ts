import { describe, expect, it } from 'vitest';

import { catalogOf, translate, type MessageKey } from '../../i18n/i18n';
import { PREFERENCE_KEYS } from './preferenceSchema';
import { SECTIONS, SETTINGS, countBySection, searchSettings, settingsOf } from './settingsIndex';

const en = (key: MessageKey) => translate('en', key);
const fr = (key: MessageKey) => translate('fr', key);

describe('the settings index', () => {
  it('has one setting per preference, each in a known section', () => {
    const keys = SETTINGS.flatMap((setting) => (setting.key === null ? [] : [setting.key]));
    expect([...keys].sort()).toEqual([...PREFERENCE_KEYS].sort());
    for (const setting of SETTINGS) {
      expect(SECTIONS.some((section) => section.id === setting.section)).toBe(true);
    }
    expect(new Set(SETTINGS.map((setting) => setting.id)).size).toBe(SETTINGS.length);
  });

  it('has a label and a one-line description in both languages', () => {
    for (const setting of SETTINGS) {
      for (const suffix of ['', '.hint']) {
        const key = `preferences.setting.${setting.id}${suffix}` as MessageKey;
        expect(catalogOf('en')[key], key).toBeTruthy();
        expect(catalogOf('fr')[key], key).toBeTruthy();
      }
    }
  });

  it('shows every section at least one setting', () => {
    for (const section of SECTIONS) expect(settingsOf(section.id).length).toBeGreaterThan(0);
  });
});

describe('searching the settings', () => {
  it('matches nothing to filter on an empty query', () => {
    expect(searchSettings('  ', en)).toBeNull();
  });

  it('finds a setting by its label, its description or its choices', () => {
    expect(searchSettings('line numbers', en)).toContain('lineNumbers');
    expect(searchSettings('keychain', en)).toContain('keychain');
    expect(searchSettings('italic', en)).toContain('nullStyle');
    expect(searchSettings('graphite', en)).toContain('theme');
  });

  it('needs every word, in any order, and ignores case and accents', () => {
    expect(searchSettings('wrap lines', en)).toContain('lineWrapping');
    expect(searchSettings('wrap zebra', en)?.size).toBe(0);
    expect(searchSettings('HISTORIQUE', fr)).toContain('historyEnabled');
    expect(searchSettings('delai', fr)).toContain('connectTimeoutSecs');
  });

  it('counts the matches by section', () => {
    const found = searchSettings('history', en);
    expect(found).not.toBeNull();
    const counts = countBySection(found ?? new Set());
    expect(counts.get('history')).toBeGreaterThanOrEqual(2);
  });
});
