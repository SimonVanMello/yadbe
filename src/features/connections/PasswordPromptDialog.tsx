import { useState, type SubmitEvent } from 'react';

import type { MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { SecretKind } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { ConnectionBanner } from './ConnectionBanner';
import { useKeychainAvailable } from './connectionStore';
import type { ConnectionSummary } from './model';
import { usePasswordPrompt, type PromptedSecretRequest } from './passwordPromptStore';
import { isPassphrase } from './sshModel';
import styles from './PasswordPromptDialog.module.css';

const PROMPT_TITLES: Partial<Record<SecretKind, MessageKey>> = {
  sshPassword: 'connection.ssh.prompt.sshPassword',
  sshPassphrase: 'connection.ssh.prompt.sshPassphrase',
  jumpPassword: 'connection.ssh.prompt.jumpPassword',
  jumpPassphrase: 'connection.ssh.prompt.jumpPassphrase',
  tlsKeyPassphrase: 'connection.tls.prompt.title',
};

function PromptForm({
  connection,
  secret,
}: {
  connection: ConnectionSummary;
  secret: PromptedSecretRequest | null;
}) {
  const t = useT();
  const settle = usePasswordPrompt((state) => state.settle);
  const keychainAvailable = useKeychainAvailable();
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    settle({ password, remember: remember && keychainAvailable });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
      title={t((secret && PROMPT_TITLES[secret.kind]) ?? 'connection.password.prompt.title', {
        name: connection.name,
      })}
      description={
        secret
          ? t(
              secret.kind === 'tlsKeyPassphrase'
                ? 'connection.tls.prompt.description'
                : 'connection.ssh.prompt.description',
              { endpoint: secret.endpoint },
            )
          : t('connection.password.prompt.description', { target: connection.target })
      }
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              settle(null);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="password-form">
            {t('connection.menu.connect')}
          </Button>
        </>
      }
    >
      <ConnectionBanner connection={connection} />
      <form id="password-form" className={styles.form} onSubmit={submit}>
        <Field
          label={
            secret === null
              ? t('connection.password')
              : isPassphrase(secret.kind)
                ? t('connection.ssh.prompt.passphrase')
                : t('connection.ssh.prompt.password')
          }
          htmlFor="prompt-password"
        >
          <TextInput
            id="prompt-password"
            type="password"
            mono
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </Field>
        <Switch
          checked={remember && keychainAvailable}
          disabled={!keychainAvailable}
          onCheckedChange={setRemember}
          label={t('connection.remember')}
          hint={
            keychainAvailable
              ? t('connection.remember.keychain')
              : t('connection.keychainUnavailable')
          }
        />
      </form>
    </Dialog>
  );
}

/** Asks for a password at connect time when none is stored (F-005). Mount once in the shell. */
export function PasswordPromptDialog() {
  const pending = usePasswordPrompt((state) => state.pending);
  if (!pending) return null;
  return (
    <PromptForm
      key={`${pending.connection.id}:${pending.secret?.kind ?? 'password'}`}
      connection={pending.connection}
      secret={pending.secret}
    />
  );
}
