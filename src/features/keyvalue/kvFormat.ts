import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { KvKeyKind } from '../../ipc';
import type { IconName } from '../../ui/Icon';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** A time to live, short: `42 s`, `5 min 03 s`, `3 h 07 min`, `2 d 4 h`. */
export function formatTtl(ms: number, t: Translate): string {
  const total = Math.floor(ms / 1000);
  if (total < 1) return t('keyValue.ttl.lessThanSecond');
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return t('keyValue.ttl.days', { d: days, h: hours });
  if (hours > 0) return t('keyValue.ttl.hours', { h: hours, m: two(minutes) });
  if (minutes > 0) return t('keyValue.ttl.minutes', { m: minutes, s: two(seconds) });
  return t('keyValue.ttl.seconds', { s: seconds });
}

const LENGTH_KEYS: Partial<Record<KvKeyKind, MessageKey>> = {
  string: 'keyValue.length.string',
  hash: 'keyValue.length.hash',
  list: 'keyValue.length.list',
  set: 'keyValue.length.set',
  zset: 'keyValue.length.zset',
  stream: 'keyValue.length.stream',
};

/** The length of a key in the words of its type (`1 300 fields`), `null` when it has none. */
export function lengthLabel(kind: KvKeyKind, length: number, t: Translate): string | null {
  const key = LENGTH_KEYS[kind];
  return key ? t(key, { count: length }) : null;
}

/** The short name shown in a key's type badge. */
export function typeBadge(kind: KvKeyKind, typeName: string): string {
  switch (kind) {
    case 'json':
      return 'json';
    case 'unknown':
      return typeName;
    case 'missing':
      return '—';
    default:
      return kind;
  }
}

export function kindIcon(kind: KvKeyKind | null): IconName {
  switch (kind) {
    case 'hash':
      return 'hash';
    case 'list':
      return 'list';
    case 'set':
      return 'layers';
    case 'zset':
      return 'index';
    case 'stream':
      return 'timeline';
    case 'json':
      return 'tree';
    case 'unknown':
    case 'missing':
      return 'warning';
    default:
      return 'key';
  }
}
