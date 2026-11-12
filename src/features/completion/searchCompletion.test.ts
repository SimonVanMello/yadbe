import { describe, expect, it } from 'vitest';

import { searchContext, searchSuggest, type SearchData } from './searchCompletion';

const data: SearchData = {
  targets: ['orders', 'orders-live', 'logs-app'],
  fields: (target) =>
    target === 'orders'
      ? [
          { path: 'status', typeName: 'keyword', sortable: true },
          { path: 'total', typeName: 'double', sortable: true },
          { path: 'title', typeName: 'text', sortable: false },
          { path: 'customer.name', typeName: 'keyword', sortable: true },
        ]
      : null,
};

/** The labels offered with the cursor at `|`. */
function labels(source: string, explicit = false): string[] | null {
  const position = source.indexOf('|');
  const text = source.replace('|', '');
  return searchSuggest(text, position, data, explicit)?.options.map((o) => o.label) ?? null;
}

describe('search console context', () => {
  it('tells a method, a path and a body apart', () => {
    expect(searchContext('GE', 2)).toMatchObject({ kind: 'method', prefix: 'GE' });
    expect(searchContext('GET /ord', 8)).toMatchObject({
      kind: 'path',
      prefix: 'ord',
      segments: [],
    });
    expect(searchContext('GET /orders/_se', 15)).toMatchObject({
      kind: 'path',
      prefix: '_se',
      segments: ['orders'],
    });
    const body = 'POST /orders/_search\n{\n  "que';
    expect(searchContext(body, body.length)).toMatchObject({
      kind: 'key',
      prefix: 'que',
      quoted: true,
      endpoint: '_search',
      target: 'orders',
    });
  });

  it('finds the next request after a body', () => {
    const text = 'GET /a/_search\n{ "size": 1 }\n\nGET /_ca';
    expect(searchContext(text, text.length)).toMatchObject({ kind: 'path', prefix: '_ca' });
    const second = 'GET /a/_search\n{ "size": 1 }\n\nGE';
    expect(searchContext(second, second.length)).toMatchObject({ kind: 'method' });
  });
});

describe('search console suggestions', () => {
  it('offers the methods', () => {
    expect(labels('G|')).toEqual(['GET']);
    expect(labels('P|')).toEqual(['POST', 'PUT']);
    expect(labels('|')).toBeNull();
    expect(labels('|', true)).toContain('DELETE');
  });

  it('offers the names of the cluster and the endpoints in the path', () => {
    expect(labels('GET /ord|')).toEqual(['orders', 'orders-live']);
    expect(labels('GET /_ca|')).toEqual(['_cat']);
    expect(labels('GET /_cat/in|')).toEqual(['indices']);
    expect(labels('GET /orders/_sea|')).toEqual(['_search']);
    expect(labels('GET /orders/_|')).toContain('_mapping');
    expect(labels('GET /|')?.slice(0, 3)).toEqual(['logs-app', 'orders', 'orders-live']);
    expect(labels('GET /_cat/indices/or|')).toEqual(['orders', 'orders-live']);
    expect(labels('GET /orders/_search?si|')).toBeNull();
  });

  it('offers the top-level keys of a search body, quoted unless already in quotes', () => {
    expect(labels('GET /orders/_search\n{ "qu|')).toEqual(['query']);
    const found = searchSuggest(
      'GET /orders/_search\n{ qu',
      'GET /orders/_search\n{ qu'.length,
      data,
    );
    expect(found?.options[0]).toMatchObject({ label: 'query', apply: '"query"' });
    expect(labels('GET /orders/_count\n{ "q|')).toEqual(['query']);
  });

  it('offers query types, bool clauses and the mapping fields', () => {
    expect(labels('GET /orders/_search\n{ "query": { "ma|')).toEqual([
      'match',
      'match_all',
      'match_none',
      'match_phrase',
      'match_phrase_prefix',
    ]);
    expect(labels('GET /orders/_search\n{ "query": { "bool": { "mu|')).toEqual([
      'must',
      'must_not',
    ]);
    expect(labels('GET /orders/_search\n{ "query": { "bool": { "must": [ { "te|')).toEqual([
      'term',
      'terms',
    ]);
    expect(labels('GET /orders/_search\n{ "query": { "match": { "ti|')).toEqual(['title']);
    expect(labels('GET /orders/_search\n{ "query": { "range": { "to|')).toEqual(['total']);
    expect(labels('GET /orders/_search\n{ "sort": [ { "st|')).toEqual(['status']);
    expect(labels('GET /orders/_search\n{ "sort": [ { "ti|')).toBeNull();
  });

  it('offers aggregation types under a name, and fields as values', () => {
    expect(labels('GET /orders/_search\n{ "aggs": { "by_status": { "te|')).toEqual(['terms']);
    expect(labels('GET /orders/_search\n{ "aggs": { "by_status": { "terms": { "fi|')).toEqual([
      'field',
    ]);
    expect(
      labels('GET /orders/_search\n{ "aggs": { "by_status": { "terms": { "field": "st|'),
    ).toEqual(['status']);
    expect(labels('GET /orders/_search\n{ "_source": [ "cu|')).toEqual(['customer.name']);
    // The name of an aggregation is the user's own.
    expect(labels('GET /orders/_search\n{ "aggs": { "|', true)).toBeNull();
  });

  it('offers no fields for an index whose mapping is not cached', () => {
    expect(labels('GET /logs-app/_search\n{ "query": { "match": { "me|')).toBeNull();
    expect(labels('GET /_search\n{ "query": { "match": { "me|')).toBeNull();
  });

  it('stays quiet in values it knows nothing about', () => {
    expect(labels('GET /orders/_search\n{ "size": 1|')).toBeNull();
    expect(labels('GET /orders/_search\n{ "query": { "match": { "title": "qu|')).toBeNull();
  });
});
