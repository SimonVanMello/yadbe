import { useId, type ClipboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { TlsMode } from '../../ipc';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { usePreference } from '../preferences/preferenceStore';
import styles from './ConnectionForm.module.css';
import type { EngineFieldsProps } from './EngineFields';
import { looksLikeConnectionString } from './model';
import { SshFields } from './SshFields';
import { TlsClientFields } from './TlsClientFields';

/** Redis has no in-protocol upgrade to TLS: a connection is plain or TLS from the start. */
const KV_TLS_MODES: readonly TlsMode[] = ['disable', 'require', 'verifyFull'];

/**
 * The engine fields of the key-value family (Redis, Valkey): server, ACL user and password,
 * database index, TLS (CA and client certificate), key delimiter, and the SSH tunnel. A pasted
 * `redis://` / `rediss://` URL fills them; its password goes to the backend, never the form.
 */
export function KeyValueConnectionFields({
  draft,
  info,
  errors,
  passwordLocation,
  keychainAvailable,
  sshSecretLocations,
  onChange,
  onPasteConnectionString,
  onPickKey,
  onPickTlsFile,
}: EngineFieldsProps) {
  const t = useT();
  const id = useId();
  const defaultDelimiter = usePreference('keyValueDelimiter');
  const remember = keychainAvailable && draft.rememberPassword;
  // `prefer` (the SQL engines' local default) is plain TCP here.
  const tlsMode: TlsMode = draft.tlsMode === 'prefer' ? 'disable' : draft.tlsMode;

  const onPasteHost = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!looksLikeConnectionString(text)) return;
    event.preventDefault();
    onPasteConnectionString(text);
  };

  return (
    <>
      <div className={styles.row}>
        <Field
          label={t('connection.host')}
          htmlFor={`${id}-host`}
          error={errors.host ? t('connection.error.hostRequired') : undefined}
          hint={t('keyValue.form.pasteHint')}
        >
          <TextInput
            id={`${id}-host`}
            data-field="host"
            mono
            value={draft.host}
            invalid={errors.host !== undefined}
            placeholder="cache.internal.example.com"
            onChange={(event) => {
              onChange({ host: event.target.value });
            }}
            onPaste={onPasteHost}
          />
        </Field>
        <div className={styles.port}>
          <Field
            label={t('connection.port')}
            htmlFor={`${id}-port`}
            error={errors.port ? t('connection.error.portInvalid') : undefined}
          >
            <TextInput
              id={`${id}-port`}
              mono
              inputMode="numeric"
              value={draft.port}
              invalid={errors.port !== undefined}
              onChange={(event) => {
                onChange({ port: event.target.value });
              }}
            />
          </Field>
        </div>
      </div>
      <div className={styles.row}>
        <Field
          label={t('keyValue.form.user')}
          htmlFor={`${id}-user`}
          hint={t('keyValue.form.userHint')}
        >
          <TextInput
            id={`${id}-user`}
            data-field="username"
            mono
            autoComplete="off"
            value={draft.username}
            placeholder="default"
            onChange={(event) => {
              onChange({ username: event.target.value });
            }}
          />
        </Field>
        <Field
          label={t('connection.password')}
          htmlFor={`${id}-password`}
          hint={
            passwordLocation === null
              ? undefined
              : t(`connection.password.stored.${passwordLocation}`)
          }
        >
          {/* Write-only: the backend never sends a password back, so this starts empty. */}
          <TextInput
            id={`${id}-password`}
            data-field="password"
            type="password"
            mono
            autoComplete="new-password"
            value={draft.password}
            placeholder={
              draft.pendingPasswordId !== null
                ? t('connection.password.fromString')
                : passwordLocation !== null
                  ? t('connection.password.keep')
                  : undefined
            }
            onChange={(event) => {
              onChange({ password: event.target.value });
            }}
          />
        </Field>
      </div>
      <div className={styles.secret}>
        <Switch
          checked={remember}
          disabled={!keychainAvailable}
          onCheckedChange={(rememberPassword) => {
            onChange({ rememberPassword });
          }}
          label={t('connection.remember')}
          hint={remember ? t('connection.remember.keychain') : t('connection.remember.ask')}
        />
        {!keychainAvailable && (
          <p className={styles.notice} role="note">
            {t('connection.keychainUnavailable')}
          </p>
        )}
      </div>
      <div className={styles.row}>
        <Field
          label={t('keyValue.form.database')}
          htmlFor={`${id}-database`}
          error={errors.database ? t('keyValue.form.databaseInvalid') : undefined}
          hint={t('keyValue.form.databaseHint')}
        >
          <TextInput
            id={`${id}-database`}
            data-field="database"
            mono
            inputMode="numeric"
            value={draft.database}
            invalid={errors.database !== undefined}
            placeholder="0"
            onChange={(event) => {
              onChange({ database: event.target.value });
            }}
          />
        </Field>
        <Field
          label={t('keyValue.form.delimiter')}
          htmlFor={`${id}-delimiter`}
          hint={t('keyValue.form.delimiterHint', { delimiter: defaultDelimiter })}
        >
          <TextInput
            id={`${id}-delimiter`}
            data-field="keyDelimiter"
            mono
            maxLength={8}
            value={draft.keyDelimiter}
            placeholder={defaultDelimiter}
            onChange={(event) => {
              onChange({ keyDelimiter: event.target.value });
            }}
          />
        </Field>
      </div>
      <Field
        label={t('connection.tls')}
        htmlFor={`${id}-tls`}
        hint={t(`keyValue.form.tls.${tlsMode}`)}
      >
        <Select
          id={`${id}-tls`}
          data-field="tls"
          value={tlsMode}
          options={KV_TLS_MODES.map((mode) => ({
            value: mode,
            label: t(`connection.tls.${mode}`),
          }))}
          onChange={(next) => {
            onChange({ tlsMode: next });
          }}
        />
      </Field>
      {info.capabilities.clientCertificate && tlsMode !== 'disable' && (
        <TlsClientFields
          draft={draft}
          keyLocation={sshSecretLocations.tlsKeyPassphrase ?? null}
          keychainAvailable={keychainAvailable}
          onChange={onChange}
          onPick={onPickTlsFile}
        />
      )}
      <SshFields
        ssh={draft.ssh}
        errors={errors.ssh ?? {}}
        secretLocations={sshSecretLocations}
        keychainAvailable={keychainAvailable}
        onChange={(ssh) => {
          onChange({ ssh });
        }}
        onPickKey={onPickKey}
      />
    </>
  );
}
