import { describe, expect, it } from 'vitest';

import type { PlanNode } from '../../ipc';
import { heatOf, hottest, misestimate, parentsOf, visibleNodes } from './planTree';

function node(id: number, parent: number | null, depth: number, weight = 0): PlanNode {
  return {
    id,
    parent,
    depth,
    operation: `op${String(id)}`,
    relation: null,
    index: null,
    detail: null,
    estimatedRows: null,
    actualRows: null,
    loops: null,
    estimatedCost: null,
    actualTimeMs: null,
    weight,
    facts: [],
  };
}

// 0 ─ 1 ─ 2
//   └ 3
const NODES = [node(0, null, 0, 0.1), node(1, 0, 1, 0.6), node(2, 1, 2, 0.05), node(3, 0, 1, 0.25)];

describe('plan tree', () => {
  it('hides the descendants of collapsed nodes only', () => {
    expect(visibleNodes(NODES, new Set()).map((n) => n.id)).toEqual([0, 1, 2, 3]);
    expect(visibleNodes(NODES, new Set([1])).map((n) => n.id)).toEqual([0, 1, 3]);
    expect(visibleNodes(NODES, new Set([0])).map((n) => n.id)).toEqual([0]);
    expect([...parentsOf(NODES)].sort()).toEqual([0, 1]);
  });

  it('ranks and grades the costly nodes', () => {
    expect(hottest(NODES, 2).map((n) => n.id)).toEqual([1, 3]);
    expect(heatOf(0.6)).toBe('high');
    expect(heatOf(0.25)).toBe('high');
    expect(heatOf(0.1)).toBe('medium');
    expect(heatOf(0.05)).toBe('low');
  });

  it('flags estimates off by an order of magnitude', () => {
    expect(misestimate({ ...node(0, null, 0), estimatedRows: 10, actualRows: 1200 })).toBe(120);
    expect(misestimate({ ...node(0, null, 0), estimatedRows: 10, actualRows: 30 })).toBeNull();
    expect(misestimate({ ...node(0, null, 0), estimatedRows: 10, actualRows: null })).toBeNull();
  });
});
