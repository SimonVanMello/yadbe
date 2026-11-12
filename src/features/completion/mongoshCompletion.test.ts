import { describe, expect, it } from 'vitest';

import { mongoshContext, mongoshSuggest, type MongoshData } from './mongoshCompletion';

const data: MongoshData = {
  collections: ['orders', 'customers', 'system_notes'],
  databases: ['shop', 'admin'],
  fields: (collection) =>
    collection === 'orders' ? ['_id', 'status', 'total', 'customer.name', 'tags'] : null,
};

/** The labels offered with the cursor at `|`. */
function labels(source: string, explicit = false): string[] | null {
  const position = source.indexOf('|');
  const text = source.replace('|', '');
  return mongoshSuggest(text, position, data, explicit)?.options.map((o) => o.label) ?? null;
}

describe('mongosh context', () => {
  it('knows the member being typed', () => {
    expect(mongoshContext('db.ord', 6)).toMatchObject({ kind: 'db', prefix: 'ord', from: 3 });
    expect(mongoshContext('db.orders.fi', 12)).toMatchObject({
      kind: 'collection',
      collection: 'orders',
      prefix: 'fi',
    });
    expect(mongoshContext('db.orders.find({}).so', 21)).toMatchObject({ kind: 'cursor' });
    expect(mongoshContext("db.getCollection('or", 20)).toMatchObject({ kind: 'collectionName' });
    expect(mongoshContext("db['orders'].fi", 15)).toMatchObject({
      kind: 'collection',
      collection: 'orders',
    });
  });

  it('knows a call from the strings and comments around it', () => {
    const text = 'db.orders.find({ // find(\n  "status": ")", ';
    expect(mongoshContext(text, text.length)).toMatchObject({
      kind: 'field',
      collection: 'orders',
      method: 'find',
    });
  });
});

describe('mongosh suggestions', () => {
  it('offers the collections and the database methods after db.', () => {
    const found = labels('db.|') ?? [];
    expect(found).toContain('orders');
    expect(found).toContain('getCollectionNames');
    expect(found.indexOf('orders')).toBeLessThan(found.indexOf('adminCommand'));
    expect(labels('db.cus|')).toEqual(['customers']);
  });

  it('offers the methods the runtime implements after db.<collection>.', () => {
    const found = labels('db.orders.|') ?? [];
    expect(found).toContain('find');
    expect(found).toContain('updateMany');
    expect(found).not.toContain('watch');
    expect(labels('db.orders.fi|')).toEqual([
      'find',
      'findAndModify',
      'findOne',
      'findOneAndDelete',
      'findOneAndReplace',
      'findOneAndUpdate',
    ]);
  });

  it('offers cursor methods after a call, and the collection names in getCollection', () => {
    expect(labels('db.orders.find().so|')).toEqual(['sort']);
    expect(labels('db.orders.find().|')).toContain('toArray');
    expect(labels("db.getCollection('c|')")).toEqual(['customers']);
  });

  it('offers field names inside find, with the operators one $ away', () => {
    expect(labels('db.orders.find({ st|')).toEqual(['status']);
    expect(labels('db.orders.find({ |', true)).toEqual([
      '_id',
      'customer.name',
      'status',
      'tags',
      'total',
    ]);
    expect(labels('db.orders.find({ $|')).toContain('$or');
    expect(labels('db.orders.find({ status: "paid", t|')).toEqual(['tags', 'total']);
  });

  it('quotes a field that is not an identifier, unless already in quotes', () => {
    const position = 'db.orders.find({ cust'.length;
    const unquoted = mongoshSuggest('db.orders.find({ cust', position, data)?.options[0];
    expect(unquoted).toMatchObject({ label: 'customer.name', apply: '"customer.name"' });
    const text = 'db.orders.find({ "cust';
    const quoted = mongoshSuggest(text, text.length, data)?.options[0];
    expect(quoted).toMatchObject({ label: 'customer.name', apply: 'customer.name' });
  });

  it('offers operators under a field, fields under $or, stages in a pipeline', () => {
    expect(labels('db.orders.find({ total: { $|')).toContain('$gt');
    expect(labels('db.orders.find({ total: { |', true)).toContain('$gt');
    expect(labels('db.orders.find({ $or: [{ st|')).toEqual(['status']);
    expect(labels('db.orders.aggregate([{ $ma|')).toEqual(['$match']);
    expect(labels('db.orders.aggregate([{ $match: { to|')).toEqual(['total']);
    expect(labels('db.orders.aggregate([{ $limit: { to|')).toBeNull();
  });

  it('offers nothing for a collection whose fields are not cached', () => {
    expect(labels('db.customers.find({ na|')).toBeNull();
  });

  it('offers the shell commands, the BSON helpers and the databases', () => {
    expect(labels('us|')).toEqual(['use']);
    expect(labels('use sh|')).toEqual(['shop']);
    expect(labels('show co|')).toEqual(['collections']);
    expect(labels('x = ObjectI|')).toEqual(['ObjectId']);
    expect(labels('x = ISO|')).toEqual(['ISODate']);
    // `use` and `show` only start a line.
    expect(labels('x = us|')).toBeNull();
  });

  it('stays quiet where there is nothing to say', () => {
    expect(labels('db.orders.find() |')).toBeNull();
    expect(labels('|')).toBeNull();
    expect(labels('|', true)?.length).toBeGreaterThan(5);
    expect(labels('db.orders.zzz|')).toBeNull();
    expect(labels('db.orders.find({ a: "va|')).toBeNull();
  });

  it('starts at the typed word and ends at the cursor', () => {
    const suggestions = mongoshSuggest('db.orders.fi', 12, data);
    expect(suggestions).toMatchObject({ from: 10, to: 12 });
  });
});
