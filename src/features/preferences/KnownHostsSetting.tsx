import { useQuery, useQueryClient } from '@tanstack/react-query';

import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { KnownHost } from '../../ipc';
import { Button } from '../../ui/Button';
import { connectionsApi } from '../connections/connectionsApi';
import styles from './KnownHostsSetting.module.css';
import rowStyles from './SettingRow.module.css';

const KNOWN_HOSTS_KEY = ['ssh-known-hosts'] as const;

/**
 * The SSH host keys the user trusted (F-010), and the deliberate way to forget one: a changed
 * key is refused until its old key is forgotten here, never from the connection error.
 */
export function KnownHostsSetting({ label, hint }: { label: string; hint: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const hosts = useQuery({ queryKey: KNOWN_HOSTS_KEY, queryFn: connectionsApi.knownHosts });

  const forget = async (host: KnownHost) => {
    const address = `${host.host}:${String(host.port)}`;
    const confirmed = await confirm({
      title: t('preferences.sshKnownHosts.forget.title', { host: address }),
      description: t('preferences.sshKnownHosts.forget.description', { host: address }),
      confirmLabel: t('preferences.sshKnownHosts.forget.confirm'),
      danger: true,
      items: [{ label: `${address} ${host.keyType} ${host.fingerprint}`, code: true }],
    });
    if (!confirmed) return;
    try {
      await connectionsApi.forgetHostKey(host.host, host.port, host.keyType);
    } catch (error) {
      showError(error);
    }
    await queryClient.invalidateQueries({ queryKey: KNOWN_HOSTS_KEY });
  };

  return (
    <div className={styles.setting}>
      <div className={rowStyles.text}>
        <span className={rowStyles.label}>{label}</span>
        <span className={rowStyles.hint}>{hint}</span>
      </div>
      {hosts.isError && <p className={styles.empty}>{t('preferences.sshKnownHosts.loadFailed')}</p>}
      {hosts.data?.length === 0 && (
        <p className={styles.empty}>{t('preferences.sshKnownHosts.empty')}</p>
      )}
      {hosts.data && hosts.data.length > 0 && (
        <ul className={styles.list} aria-label={label}>
          {hosts.data.map((host) => (
            <li key={`${host.host}:${String(host.port)}:${host.keyType}`} className={styles.host}>
              <span className={styles.address}>
                {host.host}:{host.port}
              </span>
              <span className={styles.key}>
                {host.keyType} {host.fingerprint}
              </span>
              <Button
                size="sm"
                onClick={() => {
                  void forget(host);
                }}
              >
                {t('preferences.sshKnownHosts.forget')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
