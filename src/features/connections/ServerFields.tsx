import { useId, type ClipboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { SecretLocation } from '../../ipc';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import styles from './ConnectionForm.module.css';
import {
  TLS_MODES,
  looksLikeConnectionString,
  type ConnectionDraft,
  type DraftErrors,
  type EngineInfo,
} from './model';

interface ServerFieldsProps {
  draft: ConnectionDraft;
  info: EngineInfo;
  errors: DraftErrors;
  /** Where the password of the connection being edited is kept, `null` when there is none. */
  passwordLocation: SecretLocation | null;
  keychainAvailable: boolean;
  onChange: (patch: Partial<ConnectionDraft>) => void;
  /** Pasted text that looks like a connection string: the form fills itself from it. */
  onPasteConnectionString: (text: string) => void;
}

/** Fields of a server engine: address, login, TLS (F-001, F-005, F-009). */
export function ServerFields({
  draft,
  info,
  errors,
  passwordLocation,
  keychainAvailable,
  onChange,
  onPasteConnectionString,
}: ServerFieldsProps) {
  const t = useT();
  const id = useId();
  const remember = keychainAvailable && draft.rememberPassword;

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
        >
          <TextInput
            id={`${id}-host`}
            data-field="host"
            mono
            value={draft.host}
            invalid={errors.host !== undefined}
            placeholder="db.internal.example.com"
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
      <Field label={t('connection.database')} htmlFor={`${id}-database`}>
        <TextInput
          id={`${id}-database`}
          mono
          value={draft.database}
          placeholder={t('connection.database.placeholder')}
          onChange={(event) => {
            onChange({ database: event.target.value });
          }}
        />
      </Field>
      <div className={styles.row}>
        <Field label={t('connection.user')} htmlFor={`${id}-user`}>
          <TextInput
            id={`${id}-user`}
            mono
            autoComplete="off"
            value={draft.username}
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
      {info.capabilities.supportsTls && (
        <Field
          label={t('connection.tls')}
          htmlFor={`${id}-tls`}
          hint={
            draft.tlsModeAuto && draft.tlsMode === 'verifyFull'
              ? t('connection.tls.remoteDefault.hint')
              : t(`connection.tls.${draft.tlsMode}.hint`)
          }
        >
          <Select
            id={`${id}-tls`}
            data-field="tls"
            value={draft.tlsMode}
            options={TLS_MODES.map((mode) => ({
              value: mode,
              label: t(`connection.tls.${mode}`),
            }))}
            onChange={(tlsMode) => {
              onChange({ tlsMode });
            }}
          />
        </Field>
      )}
    </>
  );
}
