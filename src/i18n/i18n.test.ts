import { describe, expect, it } from 'vitest';

import {
  catalogOf,
  detectLocale,
  loadI18n,
  locales,
  translate,
  useI18nStore,
  type MessageKey,
} from './i18n';

describe('i18n catalogs', () => {
  const reference = Object.keys(catalogOf('en')).sort();

  it.each(locales)('%s has exactly the reference keys', (locale) => {
    expect(Object.keys(catalogOf(locale)).sort()).toEqual(reference);
  });

  it.each(locales)('%s has no empty message', (locale) => {
    for (const message of Object.values(catalogOf(locale))) {
      expect(message.trim()).not.toBe('');
    }
  });

  it.each(locales)('%s uses the same placeholders as English', (locale) => {
    const placeholders = (message: string) => (message.match(/\{\w+\}/g) ?? []).sort();
    for (const key of reference) {
      const k = key as MessageKey;
      expect(placeholders(catalogOf(locale)[k]), key).toEqual(placeholders(catalogOf('en')[k]));
    }
  });
});

describe('translate', () => {
  it('interpolates parameters', () => {
    expect(
      translate('en', 'app.version', { appVersion: '1.0.0', os: 'linux', arch: 'x86_64' }),
    ).toBe('Version 1.0.0 · linux x86_64');
  });

  it('keeps unknown placeholders visible', () => {
    expect(translate('en', 'app.version', { appVersion: '1.0.0' })).toBe(
      'Version 1.0.0 · {os} {arch}',
    );
  });

  it('translates in French', () => {
    expect(translate('fr', 'settings.theme.dark')).toBe('Sombre');
  });
});

describe('counts', () => {
  it('groups a numeric count for the locale and keeps the singular form', () => {
    expect(translate('en', 'history.clear.effect', { count: 12345 })).toBe(
      '12,345 entries will be deleted. This cannot be undone.',
    );
    expect(translate('fr', 'history.cleared', { count: 12345 }).replace(/\s/g, ' ')).toBe(
      '12 345 entrées supprimées',
    );
    expect(translate('en', 'history.cleared', { count: 1 })).toBe('1 entry deleted');
  });
});

describe('detectLocale', () => {
  it('picks the first supported language', () => {
    expect(detectLocale(['de-DE', 'fr-CA', 'en-US'])).toBe('fr');
  });

  it('falls back to English', () => {
    expect(detectLocale(['de-DE'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });
});

describe('loadI18n', () => {
  it('shows the language once its catalog is there, the last choice winning', async () => {
    const first = loadI18n('fr');
    const second = loadI18n('en');
    await Promise.all([first, second]);
    expect(useI18nStore.getState()).toMatchObject({ locale: 'en', preference: 'en' });
    expect(document.documentElement.lang).toBe('en');
    await loadI18n('fr');
    expect(useI18nStore.getState().locale).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');
    await loadI18n('en');
  });
});
