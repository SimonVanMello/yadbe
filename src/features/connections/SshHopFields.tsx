import { useId } from 'react';

import { useT } from '../../i18n/useT';
import type { SecretLocation } from '../../ipc';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import styles from './ConnectionForm.module.css';
import {
  SSH_AUTH_METHODS,
  type SshDraftErrors,
  type SshHopDraft,
  type SshHopName,
} from './sshModel';

interface SshHopFieldsProps {
  name: SshHopName;
  hop: SshHopDraft;
  errors: SshDraftErrors;
  /** Where the secret of this hop's method is kept for the connection being edited. */
  secretLocation: SecretLocation | null;
  keychainAvailable: boolean;
  onChange: (patch: Partial<SshHopDraft>) => void;
  onPickKey: () => void;
}

/** Address, user and authentication of one SSH server (the tunnel's or the jump host). */
export function SshHopFields({
  name,
  hop,
  errors,
  secretLocation,
  keychainAvailable,
  onChange,
  onPickKey,
}: SshHopFieldsProps) {
  const t = useT();
  const id = useId();
  const remember = keychainAvailable && hop.rememberSecret;
  const secretLabel =
    hop.auth === 'password' ? t('connection.ssh.password') : t('connection.ssh.passphrase');

  return (
    <>
      <div className={styles.row}>
        <Field
          label={t('connection.ssh.host')}
          htmlFor={`${id}-host`}
          error={errors[`${name}.host`] ? t('connection.ssh.error.hostRequired') : undefined}
        >
          <TextInput
            id={`${id}-host`}
            data-field={`ssh-${name}-host`}
            mono
            value={hop.host}
            invalid={errors[`${name}.host`] !== undefined}
            placeholder={name === 'jump' ? 'jump.example.com' : 'bastion.example.com'}
            onChange={(event) => {
              onChange({ host: event.target.value });
            }}
          />
        </Field>
        <div className={styles.port}>
          <Field
            label={t('connection.ssh.port')}
            htmlFor={`${id}-port`}
            error={errors[`${name}.port`] ? t('connection.error.portInvalid') : undefined}
          >
            <TextInput
              id={`${id}-port`}
              mono
              inputMode="numeric"
              placeholder="22"
              value={hop.port}
              invalid={errors[`${name}.port`] !== undefined}
              onChange={(event) => {
                onChange({ port: event.target.value });
              }}
            />
          </Field>
        </div>
      </div>
      <Field
        label={t('connection.ssh.user')}
        htmlFor={`${id}-user`}
        error={errors[`${name}.user`] ? t('connection.ssh.error.userRequired') : undefined}
      >
        <TextInput
          id={`${id}-user`}
          data-field={`ssh-${name}-user`}
          mono
          autoComplete="off"
          value={hop.username}
          invalid={errors[`${name}.user`] !== undefined}
          onChange={(event) => {
            onChange({ username: event.target.value });
          }}
        />
      </Field>
      <Field
        label={t('connection.ssh.auth')}
        hint={hop.auth === 'agent' ? t('connection.ssh.auth.agent.hint') : undefined}
      >
        <SegmentedControl
          label={t('connection.ssh.auth')}
          value={hop.auth}
          options={SSH_AUTH_METHODS.map((method) => ({
            value: method,
            label: t(`connection.ssh.auth.${method}`),
          }))}
          onChange={(auth) => {
            // A secret typed for one method is not the other's.
            onChange({ auth, secret: '' });
          }}
        />
      </Field>
      {hop.auth === 'key' && (
        <Field
          label={t('connection.ssh.keyPath')}
          htmlFor={`${id}-key`}
          hint={t('connection.ssh.keyPath.hint')}
          error={errors[`${name}.key`] ? t('connection.ssh.error.keyRequired') : undefined}
        >
          <div className={styles.fileRow}>
            <TextInput
              id={`${id}-key`}
              data-field={`ssh-${name}-key`}
              mono
              value={hop.keyPath}
              invalid={errors[`${name}.key`] !== undefined}
              placeholder="~/.ssh/id_ed25519"
              onChange={(event) => {
                onChange({ keyPath: event.target.value });
              }}
            />
            <Button onClick={onPickKey}>{t('connection.ssh.keyPath.browse')}</Button>
          </div>
        </Field>
      )}
      {hop.auth !== 'agent' && (
        <>
          <Field
            label={secretLabel}
            htmlFor={`${id}-secret`}
            hint={
              secretLocation === null
                ? undefined
                : t(`connection.ssh.secret.stored.${secretLocation}`)
            }
          >
            {/* Write-only, like the database password. */}
            <TextInput
              id={`${id}-secret`}
              data-field={`ssh-${name}-secret`}
              type="password"
              mono
              autoComplete="new-password"
              value={hop.secret}
              placeholder={
                secretLocation !== null
                  ? t('connection.password.keep')
                  : hop.auth === 'key'
                    ? t('connection.ssh.passphrase.placeholder')
                    : undefined
              }
              onChange={(event) => {
                onChange({ secret: event.target.value });
              }}
            />
          </Field>
          <Switch
            checked={remember}
            disabled={!keychainAvailable}
            onCheckedChange={(rememberSecret) => {
              onChange({ rememberSecret });
            }}
            label={t('connection.ssh.remember')}
            hint={remember ? t('connection.remember.keychain') : t('connection.remember.ask')}
          />
        </>
      )}
    </>
  );
}
