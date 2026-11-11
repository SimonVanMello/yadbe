import { memo, type CSSProperties } from 'react';

import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { useNow } from '../../ui/useNow';
import { useConnection } from '../connections/connectionStore';
import { EnvTag } from '../connections/EnvTag';
import { Highlight } from '../connections/Highlight';
import { tintOf } from '../connections/model';
import { kindLabel } from '../explorer/explorerLabels';
import { rowStyle } from '../sidebar/rowStyle';
import styles from './CommandPalette.module.css';
import { iconOf, type PaletteItem } from './paletteItems';

export interface PaletteRowProps {
  item: PaletteItem;
  indices: readonly number[];
  id: string;
  index: number;
  active: boolean;
  /** Position among the options (headings do not count). */
  posInSet: number;
  setSize: number;
  offset: number;
  height: number;
  onChoose: (item: PaletteItem, secondary: boolean) => void;
  onHover: (key: string) => void;
}

/** The name of an object, its schema first and dimmed; matched characters are emphasized. */
function QualifiedName({ item, indices }: { item: PaletteItem; indices: readonly number[] }) {
  const split = item.nameStart;
  if (split === 0) return <Highlight text={item.text} indices={indices} />;
  return (
    <>
      <span className={styles.schema}>
        <Highlight text={item.text.slice(0, split)} indices={indices.filter((i) => i < split)} />
      </span>
      <Highlight
        text={item.text.slice(split)}
        indices={indices.filter((i) => i >= split).map((i) => i - split)}
      />
    </>
  );
}

/** Environment of the connection a row belongs to (SPEC §6: always visible). */
function RowEnvironment({ connectionId }: { connectionId: string | null }) {
  const connection = useConnection(connectionId);
  if (!connection?.environment) return null;
  return (
    <EnvTag
      environment={connection.environment}
      label={connection.environmentLabel}
      tint={tintOf(connection)}
    />
  );
}

function Content({ item, indices }: { item: PaletteItem; indices: readonly number[] }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  switch (item.kind) {
    case 'action':
      return (
        <>
          <span className={styles.label}>
            <Highlight text={item.text} indices={indices} />
          </span>
          <span className={styles.detail}>{t(item.category)}</span>
          {item.disabledReason ? (
            <span className={`${styles.aside} ${styles.reason}`}>{t(item.disabledReason)}</span>
          ) : (
            item.shortcut && <Kbd shortcut={item.shortcut} />
          )}
        </>
      );
    case 'connection':
      return (
        <>
          <span className={styles.label}>
            <Highlight text={item.text} indices={indices} />
          </span>
          <span className={styles.detail}>{item.connection.target}</span>
          <RowEnvironment connectionId={item.connection.id} />
          <span className={styles.aside}>{t(`connection.state.${item.state}`)}</span>
        </>
      );
    case 'tab':
      return (
        <>
          <span className={styles.label}>
            <Highlight text={item.text} indices={indices} />
          </span>
          <span className={styles.detail}>{item.connectionName}</span>
          {item.active && <span className={styles.aside}>{t('palette.tab.active')}</span>}
        </>
      );
    case 'object':
      return (
        <>
          <span className={styles.label}>
            <QualifiedName item={item} indices={indices} />
            {item.signature !== null && <span className={styles.schema}>({item.signature})</span>}
          </span>
          <span className={styles.detail}>
            {item.connectionName} · {item.database}
          </span>
          <RowEnvironment connectionId={item.connectionId} />
          <span className={styles.aside}>{kindLabel(t, item.objectKind)}</span>
        </>
      );
    case 'saved':
      return (
        <>
          <span className={styles.label}>
            <Highlight text={item.text} indices={indices} />
          </span>
          <span className={styles.detail}>
            {item.folder}
            {item.query.snippetTrigger === null
              ? ''
              : `${item.folder === '' ? '' : ' · '}${item.query.snippetTrigger}`}
          </span>
          <RowEnvironment connectionId={item.query.connectionId} />
        </>
      );
    case 'history':
      return (
        <>
          <span className={`${styles.label} ${styles.code}`}>{item.text}</span>
          <span className={styles.detail}>
            {item.entry.connectionName}
            {item.entry.database ? ` · ${item.entry.database}` : ''}
          </span>
          <RowEnvironment connectionId={item.entry.connectionId} />
          <span className={styles.aside}>
            {formatRelativeTime(item.entry.startedAt / 1000, now, locale)}
          </span>
        </>
      );
  }
}

function PaletteRowView({
  item,
  indices,
  id,
  index,
  active,
  posInSet,
  setSize,
  offset,
  height,
  onChoose,
  onHover,
}: PaletteRowProps) {
  const disabled = item.kind === 'action' && item.disabledReason !== null;
  const style: CSSProperties = rowStyle(offset, height);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      data-row-index={index}
      data-kind={item.kind}
      data-active={active ? '' : undefined}
      className={styles.option}
      style={style}
      onMouseMove={() => {
        if (!active) onHover(item.key);
      }}
      onClick={(event) => {
        onChoose(item, event.ctrlKey || event.metaKey);
      }}
    >
      <Icon name={iconOf(item)} className={styles.icon} />
      <Content item={item} indices={indices} />
    </div>
  );
}

export const PaletteRow = memo(PaletteRowView);
