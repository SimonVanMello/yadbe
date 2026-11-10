import type { Locale } from './i18n';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

// Building an Intl formatter costs far more than formatting: the graph formats a date per row.
const relativeFormats = new Map<Locale, Intl.RelativeTimeFormat>();

/** "2 minutes ago" / "il y a 2 minutes"; under a minute reads "now" / "à l'instant". */
export function formatRelativeTime(epochSeconds: number, nowMs: number, locale: Locale): string {
  let format = relativeFormats.get(locale);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' });
    relativeFormats.set(locale, format);
  }
  const delta = epochSeconds - nowMs / 1000;
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(delta) >= seconds) return format.format(Math.round(delta / seconds), unit);
  }
  return format.format(0, 'second');
}

/** "1.3 s" / "1,3 s", "412 ms". */
export function formatDuration(ms: number, locale: Locale): string {
  if (ms < 1000) return `${new Intl.NumberFormat(locale).format(ms)} ms`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}
