import { useId } from 'react';

import { useT } from '../../i18n/useT';
import type { SecretLocation } from '../../ipc';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import styles from './ConnectionForm.module.css';
import type { ConnectionDraft } from './model';

interface TlsClientFieldsProps {
  draft: ConnectionDraft;
  /** Where the passphrase of the key being edited is kept, `null` when there is none. */
  keyLocation: SecretLocation | null;
  keychainAvailable: boolean;
  onChange: (patch: Partial<ConnectionDraft>) => void;
  onPick: (file: 'cert' | 'key') => void;
}

/** The TLS client certificate of a connection (F-009): PEM files and the key's passphrase. */
export function TlsClientFields({
  draft,
  keyLocation,
  keychainAvailable,
  onChange,
  onPick,
}: TlsClientFieldsProps) {
  const t = useT();
  const id = useId();
  const remember = keychainAvailable && draft.rememberTlsKeyPassphrase;
  const hasCert = draft.tlsClientCert.trim() !== '';

  return (
    <fieldset className={styles.fileFields} data-testid="tls-client-fields">
      <legend className={styles.legend}>{t('connection.tls.client')}</legend>
      <Field
        label={t('connection.tls.cert')}
        htmlFor={`${id}-cert`}
        hint={t('connection.tls.cert.hint')}
      >
        <div className={styles.fileRow}>
          <TextInput
            id={`${id}-cert`}
            data-field="tls-cert"
            mono
            value={draft.tlsClientCert}
            placeholder="client.crt"
            onChange={(event) => {
              onChange({ tlsClientCert: event.target.value });
            }}
          />
          <Button
            onClick={() => {
              onPick('cert');
            }}
          >
            {t('connection.ssh.keyPath.browse')}
          </Button>
        </div>
      </Field>
      {hasCert && (
        <>
          <Field
            label={t('connection.tls.key')}
            htmlFor={`${id}-key`}
            hint={t('connection.tls.key.hint')}
          >
            <div className={styles.fileRow}>
              <TextInput
                id={`${id}-key`}
                data-field="tls-key"
                mono
                value={draft.tlsClientKey}
                placeholder={t('connection.tls.key.placeholder')}
                onChange={(event) => {
                  onChange({ tlsClientKey: event.target.value });
                }}
              />
              <Button
                onClick={() => {
                  onPick('key');
                }}
              >
                {t('connection.ssh.keyPath.browse')}
              </Button>
            </div>
          </Field>
          <Field
            label={t('connection.tls.passphrase')}
            htmlFor={`${id}-passphrase`}
            hint={
              keyLocation === null
                ? t('connection.tls.passphrase.hint')
                : t(`connection.ssh.secret.stored.${keyLocation}`)
            }
          >
            {/* Write-only, like every secret of the form. */}
            <TextInput
              id={`${id}-passphrase`}
              data-field="tls-passphrase"
              type="password"
              mono
              autoComplete="new-password"
              value={draft.tlsKeyPassphrase}
              placeholder={keyLocation === null ? undefined : t('connection.password.keep')}
              onChange={(event) => {
                onChange({ tlsKeyPassphrase: event.target.value });
              }}
            />
          </Field>
          <Switch
            checked={remember}
            disabled={!keychainAvailable}
            onCheckedChange={(rememberTlsKeyPassphrase) => {
              onChange({ rememberTlsKeyPassphrase });
            }}
            label={t('connection.tls.remember')}
            hint={remember ? t('connection.remember.keychain') : t('connection.remember.ask')}
          />
        </>
      )}
    </fieldset>
  );
}
