import { beforeEach, describe, expect, it } from 'vitest';

import { queryClient } from '../../app/queryClient';
import { MOCK_CONNECTIONS } from '../../ipc/mockData';
import { connectionKeys } from '../connections/connectionStore';
import { sameFamily } from './sameFamily';

const [sql] = MOCK_CONNECTIONS;
if (!sql) throw new Error('the mock has a connection');
const mongo = { ...sql, id: 'mongo', family: 'document' as const };
const redis = { ...sql, id: 'redis', family: 'keyValue' as const };

beforeEach(() => {
  queryClient.setQueryData(connectionKeys.all, { connections: [sql, mongo, redis], groups: [] });
});

describe('sameFamily', () => {
  it('accepts text between connections of one family', () => {
    expect(sameFamily(sql.id, sql.id)).toBe(true);
  });

  it('refuses SQL for a mongosh editor and the other way round', () => {
    expect(sameFamily(sql.id, 'mongo')).toBe(false);
    expect(sameFamily('mongo', sql.id)).toBe(false);
    expect(sameFamily('redis', 'mongo')).toBe(false);
  });

  it('cannot judge an unknown or absent connection, so it accepts', () => {
    expect(sameFamily(null, 'mongo')).toBe(true);
    expect(sameFamily('gone', 'mongo')).toBe(true);
    expect(sameFamily('mongo', null)).toBe(true);
  });
});
