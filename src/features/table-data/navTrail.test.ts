import { describe, expect, it } from 'vitest';

import { EMPTY_FILTER, type FilterState } from './filterModel';
import {
  canMove,
  EMPTY_TRAIL,
  forgetTab,
  moveNav,
  pushNav,
  TRAIL_SIZE,
  type NavLocation,
} from './navTrail';

const byId = (id: string): FilterState => ({
  chips: [{ column: 'id', op: 'eq', values: [id] }],
  rawWhere: '',
});

function at(tabId: string, filter: FilterState = EMPTY_FILTER, row = 0): NavLocation {
  return { tabId, filter, offset: 0, focus: { row, column: 'id' } };
}

describe('navigation trail', () => {
  it('records where a jump left from and where it went', () => {
    const orders = at('orders', EMPTY_FILTER, 4);
    const customer = at('customers', byId('7'));
    const trail = pushNav(EMPTY_TRAIL, orders, customer);
    expect(trail).toEqual({ entries: [orders, customer], index: 1 });
    expect(canMove(trail, 'customers', -1)).toBe(true);
    expect(canMove(trail, 'customers', 1)).toBe(false);
    // Only from the tab the trail stands in.
    expect(canMove(trail, 'orders', -1)).toBe(false);
  });

  it('goes back to the location as it was left, and forward again', () => {
    const orders = at('orders', EMPTY_FILTER, 4);
    const customer = at('customers', byId('7'));
    const trail = pushNav(EMPTY_TRAIL, orders, customer);
    const here = at('customers', byId('7'), 0);
    const back = moveNav(trail, -1, here);
    expect(back?.target).toEqual(orders);
    expect(back?.trail.index).toBe(0);
    if (!back) return;
    expect(canMove(back.trail, 'orders', 1)).toBe(true);
    const leftAt = at('orders', EMPTY_FILTER, 9);
    const forward = moveNav(back.trail, 1, leftAt);
    expect(forward?.target).toEqual(here);
    // The location left is updated: going back again returns to row 9.
    expect(forward?.trail.entries[0]).toEqual(leftAt);
    expect(moveNav(trail, 1, here)).toBeNull();
    expect(moveNav(trail, -1, at('elsewhere'))).toBeNull();
  });

  it('drops what was ahead on a new jump, and does not record the same place twice', () => {
    const a = at('orders');
    const b = at('customers', byId('7'));
    const c = at('addresses', byId('3'));
    let trail = pushNav(EMPTY_TRAIL, a, b);
    trail = pushNav(trail, at('customers', byId('7'), 2), c);
    expect(trail.entries.map((e) => e.tabId)).toEqual(['orders', 'customers', 'addresses']);
    expect(trail.entries[1]?.focus?.row).toBe(2);
    const back = moveNav(trail, -1, c);
    if (!back) throw new Error('back');
    const d = at('orders', byId('99'));
    trail = pushNav(back.trail, at('customers', byId('7')), d);
    expect(trail.entries.map((e) => e.tabId)).toEqual(['orders', 'customers', 'orders']);
    expect(trail.index).toBe(2);
  });

  it('a jump within one tab (self-reference) keeps both filters', () => {
    const tree = at('tree', EMPTY_FILTER, 3);
    const parent = at('tree', byId('1'));
    const trail = pushNav(EMPTY_TRAIL, tree, parent);
    expect(trail.entries).toHaveLength(2);
    expect(moveNav(trail, -1, parent)?.target.filter).toEqual(EMPTY_FILTER);
  });

  it('keeps a bounded number of entries', () => {
    let trail = EMPTY_TRAIL;
    for (let i = 0; i < TRAIL_SIZE + 10; i++) {
      trail = pushNav(trail, at('t', byId(String(i))), at('t', byId(String(i + 1))));
    }
    expect(trail.entries).toHaveLength(TRAIL_SIZE);
    expect(trail.index).toBe(TRAIL_SIZE - 1);
  });

  it('forgets a closed tab', () => {
    const a = at('orders');
    const b = at('customers', byId('7'));
    const c = at('orders', byId('1'));
    let trail = pushNav(EMPTY_TRAIL, a, b);
    trail = pushNav(trail, b, c);
    const forgotten = forgetTab(trail, 'customers');
    expect(forgotten.entries).toEqual([a, c]);
    expect(forgotten.index).toBe(1);
    expect(forgetTab(forgetTab(forgotten, 'orders'), 'orders')).toEqual({ entries: [], index: -1 });
    expect(forgetTab(trail, 'nope')).toBe(trail);
  });
});
