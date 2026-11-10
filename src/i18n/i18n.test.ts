import { describe, expect, it } from 'vitest';

import { catalogs, detectLocale, locales, translate } from './i18n';

describe('i18n catalogs', () => {
  const reference = Object.keys(catalogs.en).sort();

  it.each(locales)('%s has exactly the reference keys', (locale) => {
    expect(Object.keys(catalogs[locale]).sort()).toEqual(reference);
  });

  it.each(locales)('%s has no empty message', (locale) => {
    for (const message of Object.values(catalogs[locale])) {
      expect(message.trim()).not.toBe('');
    }
  });

  it.each(locales)('%s uses the same placeholders as English', (locale) => {
    const placeholders = (message: string) => (message.match(/\{\w+\}/g) ?? []).sort();
    for (const key of reference) {
      const k = key as keyof typeof catalogs.en;
      expect(placeholders(catalogs[locale][k]), key).toEqual(placeholders(catalogs.en[k]));
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

describe('detectLocale', () => {
  it('picks the first supported language', () => {
    expect(detectLocale(['de-DE', 'fr-CA', 'en-US'])).toBe('fr');
  });

  it('falls back to English', () => {
    expect(detectLocale(['de-DE'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });
});
