import { describe, expect, it } from 'vitest';

import type { ObjectProperties, TableDetails } from '../../ipc';
import {
  ddlTargetKind,
  ddlTargetName,
  ddlTargetObject,
  dependencyKey,
  factsOf,
  nameConfirmed,
  needsTypedName,
  pinOf,
  pinnedRef,
  samePin,
  sameDdlTarget,
  structureOf,
  supportOf,
} from './objectsModel';

const ORDERS = { database: 'shop', schema: 'sales', name: 'orders' };

function properties(change: Partial<ObjectProperties> = {}): ObjectProperties {
  return {
    object: ORDERS,
    kind: 'table',
    owner: null,
    comment: null,
    rowEstimate: null,
    dataBytes: null,
    indexBytes: null,
    totalBytes: null,
    created: null,
    modified: null,
    storageEngine: null,
    collation: null,
    lastAnalyzed: null,
    lastVacuumed: null,
    ...change,
  };
}

describe('confirmation', () => {
  it('asks for the name to drop or truncate on a production connection, not to rename', () => {
    expect(needsTypedName('prod', 'drop')).toBe(true);
    expect(needsTypedName('prod', 'truncate')).toBe(true);
    expect(needsTypedName('prod', 'rename')).toBe(false);
    expect(needsTypedName('staging', 'drop')).toBe(false);
    expect(needsTypedName(null, 'drop')).toBe(false);
  });

  it('takes the name exactly: case and spaces belong to it', () => {
    expect(nameConfirmed('orders', 'orders')).toBe(true);
    expect(nameConfirmed('Orders', 'orders')).toBe(false);
    expect(nameConfirmed('orders ', 'orders')).toBe(false);
    expect(nameConfirmed('', 'orders')).toBe(false);
  });
});

describe('engine support', () => {
  const info = {
    objectActions: [{ kind: 'view' as const, drop: true, truncate: false, rename: false }],
  };

  it('reads what the engine offers per kind, and nothing for a kind it lacks', () => {
    expect(supportOf(info, 'view')).toEqual({
      kind: 'view',
      drop: true,
      truncate: false,
      rename: false,
    });
    expect(supportOf(info, 'sequence').drop).toBe(false);
    expect(supportOf(undefined, 'view').drop).toBe(false);
  });
});

describe('facts', () => {
  const count = (n: number) => String(n);

  it('leaves out what the engine did not give, in a fixed order', () => {
    expect(factsOf(properties(), 'en', count)).toEqual([]);
    const facts = factsOf(
      properties({ owner: 'shop_owner', rowEstimate: 1200.4, dataBytes: 2048, comment: 'Orders' }),
      'en',
      count,
    );
    expect(facts.map((fact) => fact.key)).toEqual([
      'objects.props.owner',
      'objects.props.rowEstimate',
      'objects.props.dataSize',
      'objects.props.comment',
    ]);
    expect(facts[1]).toMatchObject({ value: '1200', hint: 'objects.props.rowEstimateHint' });
    expect(facts[2]?.value).toMatch(/KB|KiB/);
  });

  it('does not show a blank text as a fact', () => {
    expect(factsOf(properties({ owner: '  ', comment: '' }), 'en', count)).toEqual([]);
  });
});

describe('structure', () => {
  const details = {
    table: ORDERS,
    kind: 'table',
    comment: null,
    rowEstimate: null,
    columns: [
      { name: 'id', typeName: 'integer' },
      { name: 'total', typeName: 'numeric' },
    ],
    primaryKey: { name: 'orders_pkey', columns: ['id'] },
    uniqueKeys: [],
    foreignKeys: [{ name: 'orders_customer_fk', columns: ['customer_id'] }],
    checks: [],
    indexes: [
      { name: 'orders_pkey', primary: true, columns: ['id'] },
      { name: 'orders_total_idx', primary: false, columns: ['total'] },
    ],
    triggers: [],
  } as unknown as TableDetails;

  it('counts and names columns, keys and indexes, skipping empty groups and the key index', () => {
    expect(structureOf(details)).toEqual([
      { key: 'objects.props.columns', count: 2, names: ['id', 'total'] },
      { key: 'objects.props.primaryKey', count: 1, names: ['id'] },
      { key: 'objects.props.foreignKeys', count: 1, names: ['orders_customer_fk'] },
      { key: 'objects.props.indexes', count: 1, names: ['orders_total_idx'] },
    ]);
  });
});

describe('DDL targets', () => {
  const object = { type: 'object', object: ORDERS, kind: 'table', id: 'orders' } as const;
  const trigger = { type: 'trigger', table: ORDERS, name: 'orders_touch' } as const;

  it('name what they are about', () => {
    expect(ddlTargetName(object)).toBe('orders');
    expect(ddlTargetKind(object)).toBe('table');
    expect(ddlTargetName(trigger)).toBe('orders_touch');
    expect(ddlTargetKind(trigger)).toBe('trigger');
    expect(ddlTargetObject(trigger)).toEqual(ORDERS);
  });

  it('are the same when they address the same thing', () => {
    expect(sameDdlTarget(object, { ...object })).toBe(true);
    expect(sameDdlTarget(object, trigger)).toBe(false);
  });
});

describe('pins', () => {
  it('are told apart by connection, address, kind and id', () => {
    const pin = pinOf('c', ORDERS, 'table');
    expect(samePin(pin, pinOf('c', ORDERS, 'table'))).toBe(true);
    expect(samePin(pin, pinOf('d', ORDERS, 'table'))).toBe(false);
    expect(samePin(pin, pinOf('c', ORDERS, 'view'))).toBe(false);
    expect(samePin(pin, pinOf('c', { ...ORDERS, name: 'other' }, 'table'))).toBe(false);
  });

  it('keep the id of a routine, and the schema itself for a schema pin', () => {
    const routine = pinOf('c', { ...ORDERS, name: 'total' }, 'function', 'total(integer)');
    expect(routine.id).toBe('total(integer)');
    const schema = pinOf('c', { database: 'shop', schema: 'sales', name: 'sales' }, null, 'x');
    expect(schema).toMatchObject({ kind: null, name: 'sales', id: 'sales' });
    expect(pinnedRef(schema)).toEqual({ database: 'shop', schema: 'sales', name: 'sales' });
  });
});

describe('dependencies', () => {
  it('say how an object depends on another', () => {
    expect(dependencyKey(null)).toBeNull();
    expect(dependencyKey({ type: 'foreignKey', name: 'fk' })).toBe(
      'objects.action.dependents.foreignKey',
    );
    expect(dependencyKey({ type: 'column', name: 'c' })).toBe('objects.action.dependents.column');
  });
});
