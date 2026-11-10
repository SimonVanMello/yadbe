import { useState } from 'react';

import { useAppInfo } from '../../app/useAppInfo';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { useKeychainAvailable } from '../connections/connectionStore';
import { ClearHistoryDialog } from '../history/ClearHistoryDialog';
import styles from './SettingRow.module.css';
import type { SettingId } from './settingsIndex';

interface CustomSettingProps {
  id: SettingId;
  label: string;
  hint: string;
}

const OS_NAMES: Record<string, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };

function Info({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.info}>
      <div className={styles.text}>
        <span className={styles.label}>{label}</span>
        <span className={styles.hint}>{hint}</span>
      </div>
      <div className={styles.value}>{children}</div>
    </div>
  );
}

function ClearHistoryRow({ label, hint }: { label: string; hint: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Info label={label} hint={hint}>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('history.clear')}
      </Button>
      {open && (
        <ClearHistoryDialog
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </Info>
  );
}

function KeychainRow({ label, hint }: { label: string; hint: string }) {
  const t = useT();
  const available = useKeychainAvailable();
  return (
    <Info label={label} hint={hint}>
      <span data-testid="keychain-status">
        {t(available ? 'preferences.keychain.available' : 'preferences.keychain.session')}
      </span>
    </Info>
  );
}

function AboutRow({
  id,
  label,
  hint,
}: {
  id: 'version' | 'platform';
  label: string;
  hint: string;
}) {
  const info = useAppInfo();
  const value =
    id === 'version'
      ? (info.data?.appVersion ?? '…')
      : info.data
        ? `${OS_NAMES[info.data.os] ?? info.data.os} · ${info.data.arch}`
        : '…';
  return (
    <Info label={label} hint={hint}>
      <span className={styles.mono}>{value}</span>
    </Info>
  );
}

/** Settings that report something or open a dialog instead of holding a value. */
export function CustomSetting({ id, label, hint }: CustomSettingProps) {
  const t = useT();
  switch (id) {
    case 'clearHistory':
      return <ClearHistoryRow label={label} hint={hint} />;
    case 'keychain':
      return <KeychainRow label={label} hint={hint} />;
    case 'version':
    case 'platform':
      return <AboutRow id={id} label={label} hint={hint} />;
    case 'displayFormats':
      return (
        <Info label={label} hint={hint}>
          <Select
            aria-label={label}
            disabled
            value="iso"
            options={[{ value: 'iso', label: t('preferences.formats.iso') }]}
            onChange={() => undefined}
          />
        </Info>
      );
    case 'tlsRule':
      return (
        <Info label={label} hint={hint}>
          <span>{t('preferences.tlsRule.value')}</span>
        </Info>
      );
    case 'license':
      return (
        <Info label={label} hint={hint}>
          <span className={styles.mono}>GPL-3.0-or-later</span>
        </Info>
      );
    default:
      return null;
  }
}
