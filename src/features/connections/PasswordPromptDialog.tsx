import { useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { ConnectionBanner } from './ConnectionBanner';
import { useKeychainAvailable } from './connectionStore';
import type { ConnectionSummary } from './model';
import { usePasswordPrompt } from './passwordPromptStore';
import styles from './PasswordPromptDialog.module.css';

function PromptForm({ connection }: { connection: ConnectionSummary }) {
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
      title={t('connection.password.prompt.title', { name: connection.name })}
      description={t('connection.password.prompt.description', {
        target: connection.target,
      })}
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
        <Field label={t('connection.password')} htmlFor="prompt-password">
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
  return <PromptForm key={pending.connection.id} connection={pending.connection} />;
}
