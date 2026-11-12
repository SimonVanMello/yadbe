import { describe, expect, it } from 'vitest';

import { mockPlan, mockQueryParameters } from './queryTools';

const labels = (engine: Parameters<typeof mockQueryParameters>[0], text: string) =>
  mockQueryParameters(engine, text, { kind: 'all' }).map((p) => p.label);

describe('mock query parameters', () => {
  it('finds the placeholders each engine reads, never in strings, comments or casts', () => {
    expect(labels('postgres', "select :a, $2, x::int, ':no' -- :no\n from t where b = :a")).toEqual(
      [':a', '$2'],
    );
    expect(labels('mysql', 'select ?, :id, @user, `a?`')).toEqual(['?', ':id']);
    expect(labels('sqlite', 'select ?, ?2, :a, @b, $c')).toEqual(['?', '?2', ':a', '@b', '$c']);
    expect(labels('mssql', 'DECLARE @a int = 1, @b int; SELECT @a, @id, @@ROWCOUNT, [@x]')).toEqual(
      ['@id'],
    );
  });

  it('merges a name used twice and numbers positional ones across statements', () => {
    const found = mockQueryParameters('mysql', 'select ?, :a; select ?, :a', { kind: 'all' });
    expect(found.map((p) => p.name)).toEqual(['#1', 'a', '#2']);
    expect(found[1]?.occurrences).toHaveLength(2);
  });
});

describe('mock plans', () => {
  it('weighs the nodes and keeps parents before their children', () => {
    const plan = mockPlan('postgres', 'select * from orders o join customers c on true', true);
    expect(plan.analyzed).toBe(true);
    const total = plan.nodes.reduce((sum, node) => sum + (node.weight ?? 0), 0);
    expect(total).toBeCloseTo(1, 5);
    for (const node of plan.nodes) {
      if (node.parent !== null) expect(node.parent).toBeLessThan(node.id);
    }
    expect(plan.nodes.some((node) => node.relation === 'orders')).toBe(true);
  });
});
