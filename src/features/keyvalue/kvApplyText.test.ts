import { describe, expect, it } from 'vitest';

import en from '../../i18n/en.json';
import fr from '../../i18n/fr.json';
import { translate } from '../../i18n/i18n';
import { applyDescriptionKey, confirmDescriptionKey } from './kvApplyText';

describe('apply and revert sentences of a key change set', () => {
  it('says one checked transaction up to 500 keys and several above, never both', () => {
    expect(applyDescriptionKey(true, 1)).toBe('keyValue.revert.description');
    expect(applyDescriptionKey(false, 1)).toBe('keyValue.apply.description');
    expect(applyDescriptionKey(true, 4)).toBe('keyValue.revert.description.batched');
    expect(applyDescriptionKey(false, 4)).toBe('keyValue.apply.description.batched');
    expect(confirmDescriptionKey(1)).toBe('keyValue.edit.confirmDescription');
    expect(confirmDescriptionKey(2)).toBe('keyValue.edit.confirmDescription.batched');
  });

  it('has a sentence for each case in both languages, none mixing the two claims', () => {
    for (const catalog of [en, fr]) {
      for (const key of [
        'keyValue.revert.description.batched',
        'keyValue.apply.description.batched',
        'keyValue.edit.confirmDescription.batched',
      ] as const) {
        expect(catalog[key]).toContain('{batches}');
        expect(catalog[key]).toContain('500');
        expect(catalog[key]).not.toMatch(/one (checked )?transaction|une (seule )?transaction/i);
      }
    }
  });
});

describe('plural forms of the family wording', () => {
  it('has a singular and a plural count for every family', () => {
    expect(translate('en', 'tableData.apply.counts.one', { count: 1 })).toBe('1 row changed');
    expect(translate('en', 'keyValue.edit.appliedCount', { count: 3 })).toBe('3 keys changed');
    expect(translate('en', 'keyValue.edit.appliedCount', { count: 1 })).toBe('1 key changed');
    expect(translate('fr', 'mongo.edit.appliedCount', { count: 0 })).toBe('0 document modifié');
    expect(translate('en', 'mongo.edit.appliedCount', { count: 2 })).toBe('2 documents changed');
  });
});
