import { platform, type Platform } from '../ui/platform';
import { eventKey } from '../ui/shortcuts';

/** What the user changed: a shortcut rebinds an action, `null` leaves it without one. */
export type Overrides = Readonly<Record<string, string | null>>;

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

/** `Mod+Shift+K`: modifiers in a fixed order, an upper-case letter. */
export function canonicalShortcut(shortcut: string): string {
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
  return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join('+');
}

/**
 * Two shortcuts that press the same keys compare equal. `Mod` is the Control key outside macOS
 * (see `matchShortcut`), so `Ctrl+K` and `Mod+K` are one shortcut there.
 */
export function shortcutKey(shortcut: string, target: Platform = platform): string {
  const parts = shortcut.split('+');
  const key = parts.pop() ?? '';
  const modifiers = target === 'mac' ? parts : parts.map((m) => (m === 'Ctrl' ? 'Mod' : m));
  return canonicalShortcut([...modifiers, key].join('+')).toLowerCase();
}

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'OS', 'Hyper']);

export type Capture =
  | { kind: 'shortcut'; shortcut: string }
  /** Only modifiers are down: keep waiting. */
  | { kind: 'pending' }
  | { kind: 'cancel' }
  /** A combination that cannot be a shortcut (no modifier, a dead key, the Windows key…). */
  | { kind: 'invalid' };

type CaptureEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>;

/**
 * Turns the key press of a "press the shortcut" field into a shortcut string. `Mod` is ⌘ on
 * macOS and Ctrl elsewhere; the other of the two stays `Ctrl` on macOS and is refused elsewhere
 * (⊞ Win belongs to the OS).
 */
export function captureShortcut(event: CaptureEvent, target: Platform = platform): Capture {
  if (MODIFIER_KEYS.has(event.key)) return { kind: 'pending' };
  if (event.key === 'Escape') return { kind: 'cancel' };
  const mac = target === 'mac';
  if (!mac && event.metaKey) return { kind: 'invalid' };
  const key = eventKey(event);
  if (key === 'Dead' || key === 'Unidentified') return { kind: 'invalid' };
  const modifiers: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) modifiers.push('Mod');
  if (mac && event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  const withoutShift = modifiers.filter((m) => m !== 'Shift');
  // A bare key (or Shift + key) would take over typing and list navigation.
  if (withoutShift.length === 0 && !FUNCTION_KEY.test(key)) return { kind: 'invalid' };
  return { kind: 'shortcut', shortcut: canonicalShortcut([...modifiers, key].join('+')) };
}

/** Whether `text` is a shortcut `matchShortcut` understands: known modifiers, then one key. */
export function isShortcut(text: unknown): text is string {
  if (typeof text !== 'string' || text.length === 0) return false;
  const parts = text.split('+');
  const key = parts.pop();
  if (!key) return false;
  return parts.every((part) => (MODIFIER_ORDER as readonly string[]).includes(part));
}

/**
 * The overrides of a saved slice, tolerant: unknown actions and unusable shortcuts are dropped.
 * `null` (unbound on purpose) is kept.
 */
export function parseOverrides(raw: unknown, knownIds: readonly string[]): Overrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const values = (raw as { overrides?: unknown }).overrides;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return {};
  const known = new Set(knownIds);
  const result: Record<string, string | null> = {};
  for (const [id, shortcut] of Object.entries(values as Record<string, unknown>)) {
    if (!known.has(id)) continue;
    if (shortcut === null) result[id] = null;
    else if (isShortcut(shortcut)) result[id] = canonicalShortcut(shortcut);
  }
  return result;
}

/**
 * Whether two actions may share a shortcut: the ones that act in different kinds of tab can
 * (`query.save` and `table.apply`), the others cannot.
 */
export function mayShare(a: string, b: string, scopes: readonly string[]): boolean {
  const scopeOf = (id: string) => scopes.find((scope) => id.startsWith(scope)) ?? null;
  const first = scopeOf(a);
  const second = scopeOf(b);
  return first !== null && second !== null && first !== second;
}

/** Groups of actions that share a shortcut and may not, by canonical shortcut. */
export function findConflicts(
  effective: ReadonlyMap<string, string | null>,
  scopes: readonly string[],
  target: Platform = platform,
): Map<string, string[]> {
  const byShortcut = new Map<string, string[]>();
  for (const [id, shortcut] of effective) {
    if (!shortcut) continue;
    const key = shortcutKey(shortcut, target);
    byShortcut.set(key, [...(byShortcut.get(key) ?? []), id]);
  }
  for (const [key, ids] of byShortcut) {
    const clashing = ids.filter((id) =>
      ids.some((other) => other !== id && !mayShare(id, other, scopes)),
    );
    if (clashing.length < 2) byShortcut.delete(key);
    else byShortcut.set(key, clashing);
  }
  return byShortcut;
}

/** The actions that already use `shortcut` and could not share it with `id`. */
export function clashesWith(
  id: string,
  shortcut: string,
  effective: ReadonlyMap<string, string | null>,
  scopes: readonly string[],
  target: Platform = platform,
): string[] {
  const key = shortcutKey(shortcut, target);
  return [...effective]
    .filter(
      ([other, value]) =>
        other !== id &&
        value !== null &&
        shortcutKey(value, target) === key &&
        !mayShare(id, other, scopes),
    )
    .map(([other]) => other);
}
