import { useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { TunnelFailure } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { connectionsApi } from './connectionsApi';
import styles from './HostKeyDialog.module.css';
import { useHostKeyPrompt } from './hostKeyPromptStore';

function HostKeyForm({ failure }: { failure: TunnelFailure }) {
  const t = useT();
  const settle = useHostKeyPrompt((state) => state.settle);
  const [saving, setSaving] = useState(false);
  const address = `${failure.host}:${String(failure.port)}`;
  const hop = failure.hop === 'jump' ? 'jump' : 'server';

  const trust = () => {
    if (saving || failure.keyType === null || failure.fingerprint === null) return;
    setSaving(true);
    connectionsApi
      .trustHostKey(failure.host, failure.port, failure.keyType, failure.fingerprint)
      .then(() => {
        settle(true);
      })
      .catch((error: unknown) => {
        showError(error, { title: t('connection.hostKey.trustFailed') });
        settle(false);
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      title={t('connection.hostKey.title')}
      description={t('connection.hostKey.description', { host: address })}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              settle(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={trust} disabled={saving}>
            {t('connection.hostKey.trust')}
          </Button>
        </>
      }
    >
      <dl className={styles.facts}>
        <dt>{t('connection.hostKey.hop')}</dt>
        <dd>
          <Icon name="tunnel" />
          <span>{t(`connection.test.hop.${hop}`)}</span>
          <code>{address}</code>
        </dd>
        <dt>{t('connection.hostKey.keyType')}</dt>
        <dd>
          <code>{failure.keyType}</code>
        </dd>
        <dt>{t('connection.hostKey.fingerprint')}</dt>
        <dd>
          <code className={styles.fingerprint} data-testid="host-key-fingerprint">
            {failure.fingerprint}
          </code>
        </dd>
      </dl>
    </Dialog>
  );
}

/** Asks to trust an unknown SSH host key, showing its fingerprint (F-010). Mount once in the shell. */
export function HostKeyDialog() {
  const pending = useHostKeyPrompt((state) => state.pending);
  if (!pending) return null;
  return (
    <HostKeyForm
      key={`${pending.failure.host}:${String(pending.failure.port)}:${pending.failure.fingerprint ?? ''}`}
      failure={pending.failure}
    />
  );
}
