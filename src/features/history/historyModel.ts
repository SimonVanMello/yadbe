import type { HistoryOutcome, HistoryQuery, HistoryRow, HistoryScope } from '../../ipc';

/** A history row with the numbers the generated types may call `null` made plain. */
export interface HistoryEntry extends Omit<HistoryRow, 'id' | 'startedAt' | 'durationMs'> {
  /** Entries are ordered, and paginated, by id (the newest has the largest). */
  id: number;
  /** Unix time in ms. */
  startedAt: number;
  durationMs: number;
}

export function toEntry(row: HistoryRow): HistoryEntry {
  return {
    ...row,
    id: row.id ?? 0,
    startedAt: row.startedAt ?? 0,
    durationMs: row.durationMs ?? 0,
  };
}

export type RangePreset = 'any' | 'today' | 'last7' | 'last30';
export type DurationPreset = 'any' | '100' | '1000' | '10000';
export type OutcomeFilter = 'all' | HistoryOutcome;

export const RANGE_PRESETS: readonly RangePreset[] = ['any', 'today', 'last7', 'last30'];
export const DURATION_PRESETS: readonly DurationPreset[] = ['any', '100', '1000', '10000'];
export const OUTCOMES: readonly HistoryOutcome[] = ['ok', 'error', 'cancelled', 'refused'];

export interface HistoryFilters {
  text: string;
  connectionId: string | null;
  outcome: OutcomeFilter;
  range: RangePreset;
  minDuration: DurationPreset;
}

export const EMPTY_FILTERS: HistoryFilters = {
  text: '',
  connectionId: null,
  outcome: 'all',
  range: 'any',
  minDuration: 'any',
};

/** Filters other than the text: what the "Filters" button counts. */
export function activeFilterCount(filters: HistoryFilters): number {
  return (
    Number(filters.connectionId !== null) +
    Number(filters.outcome !== 'all') +
    Number(filters.range !== 'any') +
    Number(filters.minDuration !== 'any')
  );
}

export function isFiltered(filters: HistoryFilters): boolean {
  return filters.text.trim() !== '' || activeFilterCount(filters) > 0;
}

const DAY_MS = 86_400_000;

/** Local midnight at or before `time`. */
export function startOfDay(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Start of the day `days` days before the day of `now`, in local time (DST-safe). */
function daysAgo(now: number, days: number): number {
  const date = new Date(startOfDay(now));
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/**
 * Bounds of a period, in Unix ms: `from` inclusive, `to` exclusive. Whole local days, so the
 * bounds (and the query that carries them) do not change until midnight.
 */
export function rangeBounds(
  range: RangePreset,
  now: number,
): { from: number | null; to: number | null } {
  switch (range) {
    case 'any':
      return { from: null, to: null };
    case 'today':
      return { from: startOfDay(now), to: null };
    case 'last7':
      return { from: daysAgo(now, 6), to: null };
    case 'last30':
      return { from: daysAgo(now, 29), to: null };
  }
}

/** Periods the "clear" dialog offers; `older30` is the only one that is bounded above. */
export type ClearRange = RangePreset | 'older30';
export const CLEAR_RANGES: readonly ClearRange[] = ['any', 'today', 'last7', 'last30', 'older30'];

export function clearScope(
  connectionId: string | null,
  range: ClearRange,
  now: number,
): HistoryScope {
  if (range === 'older30') return { connectionId, from: null, to: daysAgo(now, 29) };
  return { connectionId, ...rangeBounds(range, now) };
}

/** A search request without its page: the page cursor is the infinite query's. */
export type HistoryBaseQuery = Omit<HistoryQuery, 'after'>;

export function toBaseQuery(filters: HistoryFilters, now: number): HistoryBaseQuery {
  const text = filters.text.trim();
  return {
    text: text === '' ? null : text,
    connectionId: filters.connectionId,
    outcomes: filters.outcome === 'all' ? [] : [filters.outcome],
    ...rangeBounds(filters.range, now),
    minDurationMs: filters.minDuration === 'any' ? null : Number(filters.minDuration),
    limit: null,
  };
}

/** One line of the list: a day heading, or an entry. */
export type HistoryItem =
  { kind: 'day'; key: string; start: number } | { kind: 'entry'; key: string; entry: HistoryEntry };

/** The entries (newest first) with a heading before each day. */
export function groupByDay(entries: readonly HistoryEntry[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  let day = Number.NaN;
  for (const entry of entries) {
    const start = startOfDay(entry.startedAt);
    if (start !== day) {
      day = start;
      items.push({ kind: 'day', key: `day:${String(start)}`, start });
    }
    items.push({ kind: 'entry', key: `entry:${String(entry.id)}`, entry });
  }
  return items;
}

/** How many calendar days `start` is before the day of `now` (0: today). */
export function dayDistance(start: number, now: number): number {
  return Math.round((startOfDay(now) - start) / DAY_MS);
}

/** A statement on one line, to show a preview of at most `max` characters. */
export function previewOf(sql: string, max: number): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** The words of a search, as the backend reads them (letters and digits, at most 12). */
export function searchWords(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).slice(0, 12);
}

/**
 * Where the search matches in `text`: the start of every word that begins like one of the
 * searched words (the backend matches words by prefix). Sorted, non-overlapping `[from, to)`.
 */
export function matchRanges(text: string, search: string): [number, number][] {
  const needles = searchWords(search);
  if (needles.length === 0) return [];
  const ranges: [number, number][] = [];
  for (const word of text.matchAll(WORD)) {
    const lower = word[0].toLowerCase();
    const needle = needles
      .filter((candidate) => lower.startsWith(candidate))
      .sort((a, b) => b.length - a.length)[0];
    if (needle !== undefined) {
      const from = word.index;
      ranges.push([from, from + needle.length]);
    }
  }
  return ranges;
}

/** Splits `text` into runs, flagging those inside a range. */
export function splitByRanges(
  text: string,
  ranges: readonly [number, number][],
): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) parts.push({ text: text.slice(at, from), match: false });
    parts.push({ text: text.slice(from, to), match: true });
    at = to;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
