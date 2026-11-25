import { describe, expect, it } from 'vitest';

import { MOCK_CONNECTIONS } from '../../ipc/mockData';
import { summarize } from '../connections/model';
import { familiesPresent, familyLabelKey, hostConnection } from './libraryFamily';

const connections = MOCK_CONNECTIONS.map(summarize);
const byFamily = (family: string) => connections.find((connection) => connection.family === family);

describe('familiesPresent', () => {
  it('lists the families of the queries once each, in the order of the view', () => {
    expect(
      familiesPresent([{ family: 'search' }, { family: 'sql' }, { family: 'search' }]),
    ).toEqual(['sql', 'search']);
    expect(familiesPresent([])).toEqual([]);
  });
});

describe('familyLabelKey', () => {
  it('names every family', () => {
    expect(familyLabelKey('keyValue')).toBe('library.family.keyValue');
    expect(familyLabelKey('sql')).toBe('library.family.sql');
  });
});

describe('hostConnection', () => {
  const sql = byFamily('sql');
  const mongo = byFamily('document');

  it('keeps the active connection when it speaks the family', () => {
    expect(hostConnection('sql', connections, sql?.id ?? null)).toEqual({
      connection: sql,
      switched: false,
    });
  });

  it('moves to the first connection of the family when the active one does not', () => {
    const host = hostConnection('document', connections, sql?.id ?? null);
    expect(host).toEqual({ connection: mongo, switched: true });
  });

  it('has no host when no connection speaks the family', () => {
    const withoutMongo = connections.filter((connection) => connection.family !== 'document');
    expect(hostConnection('document', withoutMongo, sql?.id ?? null)).toBeNull();
  });

  it('leaves the choice to the user when no connection is active', () => {
    expect(hostConnection('sql', connections, null)).toBeNull();
    expect(hostConnection('sql', connections, 'gone')).toBeNull();
  });
});
