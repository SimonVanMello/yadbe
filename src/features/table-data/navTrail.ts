import type { FilterState } from './filterModel';

/**
 * The trail of foreign key navigation (F-088), like a browser's history: where each jump left
 * from and where it went, so `Alt+←` / `Alt+→` go back and forth. A location is a table tab
 * with its filter and focused cell; going back to a tab whose filter changed puts the old one
 * back. Pure: the store and the actions are in `fkNavigation.ts`.
 */
export interface NavLocation {
  tabId: string;
  filter: FilterState;
  /** The first row of the page on screen. */
  offset: number;
  /** The focused row (in the page) and column, `null` when nothing was focused. */
  focus: { row: number; column: string } | null;
}

export interface NavTrail {
  entries: NavLocation[];
  /** The current location; `-1` when the trail is empty. */
  index: number;
}

/** Entries kept at most (the oldest go first). */
export const TRAIL_SIZE = 50;

export const EMPTY_TRAIL: NavTrail = { entries: [], index: -1 };

function sameFilter(a: FilterState, b: FilterState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The same place: a tab with the same filter (the focus may have moved). */
export function samePlace(a: NavLocation, b: NavLocation): boolean {
  return a.tabId === b.tabId && sameFilter(a.filter, b.filter);
}

/**
 * A jump from `from` to `to`: what was ahead is dropped (as in a browser), `from` is recorded
 * unless it is where the trail already stands (then its focus is updated).
 */
export function pushNav(trail: NavTrail, from: NavLocation, to: NavLocation): NavTrail {
  const kept = trail.entries.slice(0, trail.index + 1);
  const current = kept[kept.length - 1];
  if (current && samePlace(current, from)) kept[kept.length - 1] = from;
  else kept.push(from);
  kept.push(to);
  const entries = kept.slice(-TRAIL_SIZE);
  return { entries, index: entries.length - 1 };
}

/** Whether `Alt+←` / `Alt+→` apply in `tabId`: the trail's current location is there. */
export function canMove(trail: NavTrail, tabId: string, step: -1 | 1): boolean {
  const current = trail.entries[trail.index];
  const target = trail.entries[trail.index + step];
  return current !== undefined && target !== undefined && current.tabId === tabId;
}

/**
 * One step back (`-1`) or forward (`1`). `here` is where the user is now: it replaces the
 * current entry, so coming back returns to it as left. `null` when there is nowhere to go.
 */
export function moveNav(
  trail: NavTrail,
  step: -1 | 1,
  here: NavLocation,
): { trail: NavTrail; target: NavLocation } | null {
  const target = trail.entries[trail.index + step];
  const current = trail.entries[trail.index];
  if (!target || !current || current.tabId !== here.tabId) return null;
  const entries = [...trail.entries];
  entries[trail.index] = here;
  return { trail: { entries, index: trail.index + step }, target };
}

/** A tab closed: its locations leave the trail. */
export function forgetTab(trail: NavTrail, tabId: string): NavTrail {
  if (!trail.entries.some((entry) => entry.tabId === tabId)) return trail;
  let index = trail.index;
  const entries: NavLocation[] = [];
  trail.entries.forEach((entry, i) => {
    if (entry.tabId === tabId) {
      if (i <= trail.index) index -= 1;
      return;
    }
    // Two neighbors left equal once the tab between them goes: keep one.
    const previous = entries[entries.length - 1];
    if (previous && samePlace(previous, entry)) {
      if (i <= trail.index) index -= 1;
      return;
    }
    entries.push(entry);
  });
  return {
    entries,
    index: Math.max(entries.length > 0 ? 0 : -1, Math.min(index, entries.length - 1)),
  };
}
