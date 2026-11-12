import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { KvKeyInfo } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { Icon } from '../../ui/Icon';
import { formatBytes } from '../export/exportOptions';
import styles from './KeyTab.module.css';
import { formatTtl, kindIcon, lengthLabel, typeBadge } from './kvFormat';

/** The header of a key tab: the key, its type, and what the server says of it. */
export function KeyHeader({
  info,
  refreshing,
  onRefresh,
}: {
  info: KvKeyInfo;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
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
        <span className={styles.readOnly}>
          <Icon name="lock" size="sm" />
          {t('keyValue.header.readOnly')}
        </span>
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
