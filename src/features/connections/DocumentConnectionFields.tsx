import { useId, type ClipboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import styles from './ConnectionForm.module.css';
import type { EngineFieldsProps } from './EngineFields';
import { looksLikeConnectionString } from './model';
import {
  MONGO_AUTH_MECHANISMS,
  MONGO_TLS_MODES,
  mongoTunnelIssue,
  type MongoDraft,
} from './mongoModel';
import { SshFields } from './SshFields';
import { TlsClientFields } from './TlsClientFields';

/**
 * The engine fields of the document family (MongoDB): hosts or an SRV name, replica set,
 * authentication (SCRAM, X.509), TLS and the SSH tunnel. A pasted `mongodb://` or
 * `mongodb+srv://` string fills the form; its password goes to the backend, never back here.
 */
export function DocumentConnectionFields({
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
  const mongo = draft.mongo;
  const remember = keychainAvailable && draft.rememberPassword;
  const x509 = mongo.authMechanism === 'x509';
  const setMongo = (patch: Partial<MongoDraft>) => {
    onChange({ mongo: { ...mongo, ...patch } });
  };
  const onPasteHost = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!looksLikeConnectionString(text)) return;
    event.preventDefault();
    onPasteConnectionString(text);
  };
  // MongoDB has no opportunistic TLS: `prefer` (a local host's default) means none.
  const tlsMode = draft.tlsMode === 'prefer' ? 'disable' : draft.tlsMode;
  const tunnelIssue = draft.ssh.enabled ? mongoTunnelIssue(mongo, draft.host) : null;

  return (
    <>
      <div className={styles.row}>
        <Field
          label={t(mongo.srv ? 'mongo.field.srvHost' : 'mongo.field.hosts')}
          htmlFor={`${id}-host`}
          hint={t(mongo.srv ? 'mongo.field.srvHost.hint' : 'mongo.field.hosts.hint')}
          error={errors.host ? t('connection.error.hostRequired') : undefined}
        >
          <TextInput
            id={`${id}-host`}
            data-field="host"
            mono
            value={draft.host}
            invalid={errors.host !== undefined}
            placeholder={mongo.srv ? 'cluster0.example.net' : 'db1:27017, db2:27017'}
            onChange={(event) => {
              onChange({ host: event.target.value });
            }}
            onPaste={onPasteHost}
          />
        </Field>
        {!mongo.srv && (
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
        )}
      </div>
      <div className={styles.secret}>
        <Switch
          checked={mongo.srv}
          onCheckedChange={(srv) => {
            onChange({
              mongo: { ...mongo, srv, directConnection: srv ? false : mongo.directConnection },
              // DNS gives the ports of an SRV connection.
              ...(srv ? { port: '' } : {}),
            });
          }}
          label={t('mongo.field.srv')}
          hint={t('mongo.field.srv.hint')}
        />
      </div>
      <div className={styles.row}>
        <Field
          label={t('mongo.field.database')}
          htmlFor={`${id}-database`}
          hint={t('mongo.field.database.hint')}
        >
          <TextInput
            id={`${id}-database`}
            mono
            value={draft.database}
            placeholder="admin"
            onChange={(event) => {
              onChange({ database: event.target.value });
            }}
          />
        </Field>
        <Field
          label={t('mongo.field.replicaSet')}
          htmlFor={`${id}-replica`}
          hint={t('mongo.field.replicaSet.hint')}
        >
          <TextInput
            id={`${id}-replica`}
            data-field="replicaSet"
            mono
            value={mongo.replicaSet}
            placeholder="rs0"
            onChange={(event) => {
              setMongo({ replicaSet: event.target.value });
            }}
          />
        </Field>
      </div>
      {!mongo.srv && (
        <div className={styles.secret}>
          <Switch
            checked={mongo.directConnection}
            onCheckedChange={(directConnection) => {
              setMongo({ directConnection });
            }}
            label={t('mongo.field.direct')}
            hint={t('mongo.field.direct.hint')}
          />
        </div>
      )}
      <div className={styles.row}>
        <Field label={t('mongo.field.mechanism')} htmlFor={`${id}-mechanism`}>
          <Select
            id={`${id}-mechanism`}
            data-field="authMechanism"
            value={mongo.authMechanism}
            options={MONGO_AUTH_MECHANISMS.map((mechanism) => ({
              value: mechanism,
              label: t(`mongo.mechanism.${mechanism}`),
            }))}
            onChange={(authMechanism) => {
              // X.509 is a TLS client certificate: it needs TLS.
              const tls = authMechanism === 'x509' && tlsMode === 'disable';
              onChange({
                mongo: { ...mongo, authMechanism },
                ...(tls ? { tlsMode: 'verifyFull' as const } : {}),
              });
            }}
          />
        </Field>
        <Field
          label={t('mongo.field.authSource')}
          htmlFor={`${id}-auth-source`}
          hint={t('mongo.field.authSource.hint')}
        >
          <TextInput
            id={`${id}-auth-source`}
            mono
            value={x509 ? '$external' : mongo.authSource}
            disabled={x509}
            placeholder="admin"
            onChange={(event) => {
              setMongo({ authSource: event.target.value });
            }}
          />
        </Field>
      </div>
      <div className={styles.row}>
        <Field
          label={t('connection.user')}
          htmlFor={`${id}-user`}
          hint={x509 ? t('mongo.field.user.x509') : t('mongo.field.user.hint')}
        >
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
        {!x509 && (
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
        )}
      </div>
      {!x509 && (
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
      )}
      <Field
        label={t('connection.tls')}
        htmlFor={`${id}-tls`}
        hint={t(`mongo.tls.${tlsMode}.hint`)}
      >
        <Select
          id={`${id}-tls`}
          data-field="tls"
          value={tlsMode}
          options={MONGO_TLS_MODES.map((mode) => ({
            value: mode,
            label: t(`connection.tls.${mode}`),
          }))}
          onChange={(mode) => {
            onChange({ tlsMode: mode });
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
      {tunnelIssue !== null && (
        <p className={styles.notice} role="note" data-testid="mongo-tunnel-note">
          {t(`mongo.tunnel.${tunnelIssue}`)}
        </p>
      )}
    </>
  );
}
