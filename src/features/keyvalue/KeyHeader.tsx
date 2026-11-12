import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { KvKeyInfo } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { Icon } from '../../ui/Icon';
import { formatBytes } from '../export/exportOptions';
import styles from './KeyTab.module.css';
import { closeKeyTabIfGone } from './kvEditActions';
import { copyKey, deleteKeys, editTtl, renameKey } from './kvEditForms';
import { formatTtl, kindIcon, lengthLabel, typeBadge } from './kvFormat';

/**
 * The header of a key tab: the key, its type, what the server says of it, and the key-level
 * actions (time to live, rename, duplicate, delete; M4-6), disabled with the reason on a
 * read-only connection.
 */
export function KeyHeader({
  tabId,
  connectionId,
  info,
  readOnly,
  refreshing,
  onRefresh,
}: {
  tabId: string;
  connectionId: string;
  info: KvKeyInfo;
  readOnly: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  const exists = info.kind !== 'missing';
  const why = readOnly ? t('keyValue.edit.readOnly') : undefined;
  const locale = useI18nStore((state) => state.locale);
  const length = info.length === null ? null : lengthLabel(info.kind, info.length, t);
  const facts: { label: string; value: string }[] = [
    {
      label: t('keyValue.header.ttl'),
      value: info.ttlMs === null ? t('keyValue.header.noExpiry') : formatTtl(info.ttlMs, t),
    },
    ...(length === null ? [] : [{ label: t('keyValue.header.length'), value: length }]),
    ...(info.encoding === null
      ? []
      : [{ label: t('keyValue.header.encoding'), value: info.encoding }]),
    ...(info.memory === null
      ? []
      : [{ label: t('keyValue.header.memory'), value: formatBytes(info.memory, locale) }]),
    { label: t('keyValue.header.database'), value: `db${formatNumber(locale, info.database)}` },
  ];
  return (
    <header className={styles.header}>
      <div className={styles.title}>
        <Icon name={kindIcon(info.kind)} className={styles.titleIcon} />
        <span className={styles.badge} data-kind={info.kind}>
          {typeBadge(info.kind, info.typeName)}
        </span>
        <h2 className={styles.key} title={info.key.text}>
          {info.key.text}
        </h2>
        {info.key.base64 !== null && (
          <span className={styles.binary}>{t('keyValue.header.binaryKey')}</span>
        )}
        {readOnly && (
          <span className={styles.readOnly}>
            <Icon name="lock" size="sm" />
            {t('keyValue.header.readOnly')}
          </span>
        )}
        {exists && (
          <span
            className={styles.keyActions}
            role="group"
            aria-label={t('keyValue.header.actions')}
          >
            <IconButton
              label={why ?? t('keyValue.header.editTtl')}
              icon="history"
              disabled={readOnly}
              onClick={() => {
                void editTtl(tabId, info);
              }}
            />
            <IconButton
              label={why ?? t('keyValue.header.rename')}
              icon="pencil"
              disabled={readOnly}
              onClick={() => {
                void renameKey(connectionId, info.database, info.key, tabId);
              }}
            />
            <IconButton
              label={why ?? t('keyValue.header.duplicate')}
              icon="copy"
              disabled={readOnly}
              onClick={() => {
                void copyKey(connectionId, info.database, info.key);
              }}
            />
            <IconButton
              label={why ?? t('keyValue.header.delete')}
              icon="trash"
              disabled={readOnly}
              onClick={() => {
                void deleteKeys(connectionId, info.database, [info.key], tabId).then((done) => {
                  if (done) closeKeyTabIfGone(tabId);
                });
              }}
            />
          </span>
        )}
        <IconButton
          label={t('keyValue.header.refresh')}
          icon="retry"
          disabled={refreshing}
          onClick={onRefresh}
        />
      </div>
      <dl className={styles.facts}>
        {facts.map((fact) => (
          <div key={fact.label} className={styles.fact}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}
