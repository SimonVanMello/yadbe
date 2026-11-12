import { useId, type ClipboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { SearchAuth } from '../../ipc';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import styles from './ConnectionForm.module.css';
import type { EngineFieldsProps } from './EngineFields';
import { looksLikeConnectionString } from './model';
import { SEARCH_AUTHS, parseSearchUrl, searchTlsMode, type SearchDraft } from './searchModel';
import { SshFields } from './SshFields';
import { TlsClientFields } from './TlsClientFields';

/**
 * The engine fields of the search family (Elasticsearch, OpenSearch): one URL (its scheme says
 * TLS, its path is where the API is served), the kind of authentication and its secret, the
 * certificate checks of an `https://` URL (CA file, or none on a trusted network), a client
 * certificate, and the SSH tunnel. A URL holding credentials goes to the backend, which keeps
 * its password apart.
 */
export function SearchConnectionFields({
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
  const { search } = draft;
  const url = parseSearchUrl(search.url);
  const https = url?.https ?? false;
  const remember = keychainAvailable && draft.rememberPassword;

  const setSearch = (patch: Partial<SearchDraft>) => {
    const next = { ...search, ...patch };
    const parsed = parseSearchUrl(next.url);
    // The host, port and TLS mode follow the URL, so that the rest of the form (name
    // suggestion, client certificate, tunnel) reads them as for the other engines.
    onChange({
      search: next,
      ...(parsed
        ? {
            host: parsed.host,
            port: String(parsed.port),
            tlsMode: searchTlsMode(parsed.https, next.skipVerify),
          }
        : {}),
    });
  };

  const onUrl = (text: string) => {
    // Credentials in a URL go to the backend: the password must not stay in the form.
    if (parseSearchUrl(text)?.credentials) {
      onPasteConnectionString(text);
      return;
    }
    setSearch({ url: text });
  };

  const onPasteUrl = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!looksLikeConnectionString(text) || !parseSearchUrl(text)?.credentials) return;
    event.preventDefault();
    onPasteConnectionString(text);
  };

  const secretLabel =
    search.auth === 'apiKey'
      ? t('search.form.apiKey')
      : search.auth === 'bearer'
        ? t('search.form.token')
        : t('connection.password');

  return (
    <>
      <Field
        label={t('search.form.url')}
        htmlFor={`${id}-url`}
        error={errors.url ? t('search.form.urlInvalid') : undefined}
        hint={t('search.form.urlHint')}
      >
        <TextInput
          id={`${id}-url`}
          data-field="url"
          mono
          value={search.url}
          invalid={errors.url !== undefined}
          placeholder="https://search.example.com:9200"
          spellCheck={false}
          onChange={(event) => {
            onUrl(event.target.value);
          }}
          onPaste={onPasteUrl}
        />
      </Field>
      <Field
        label={t('search.form.auth')}
        htmlFor={`${id}-auth`}
        hint={t(`search.form.auth.${search.auth}.hint`)}
      >
        <Select<SearchAuth>
          id={`${id}-auth`}
          data-field="searchAuth"
          value={search.auth}
          options={SEARCH_AUTHS.map((auth) => ({
            value: auth,
            label: t(`search.form.auth.${auth}`),
          }))}
          onChange={(auth) => {
            setSearch({ auth });
          }}
        />
      </Field>
      {search.auth !== 'none' && (
        <>
          <div className={styles.row}>
            {search.auth === 'basic' && (
              <Field label={t('connection.user')} htmlFor={`${id}-user`}>
                <TextInput
                  id={`${id}-user`}
                  data-field="username"
                  mono
                  autoComplete="off"
                  value={draft.username}
                  placeholder="elastic"
                  onChange={(event) => {
                    onChange({ username: event.target.value });
                  }}
                />
              </Field>
            )}
            <Field
              label={secretLabel}
              htmlFor={`${id}-password`}
              hint={
                passwordLocation === null
                  ? undefined
                  : t(`connection.password.stored.${passwordLocation}`)
              }
            >
              {/* Write-only: the backend never sends a secret back, so this starts empty. */}
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
        </>
      )}
      {https && (
        <>
          <Field label={t('search.form.ca')} htmlFor={`${id}-ca`} hint={t('search.form.caHint')}>
            <TextInput
              id={`${id}-ca`}
              data-field="caCertPath"
              mono
              value={draft.caCertPath ?? ''}
              placeholder="/etc/elasticsearch/certs/http_ca.crt"
              spellCheck={false}
              onChange={(event) => {
                const value = event.target.value;
                onChange({ caCertPath: value.trim() === '' ? null : value });
              }}
            />
          </Field>
          <Switch
            checked={search.skipVerify}
            onCheckedChange={(skipVerify) => {
              setSearch({ skipVerify });
            }}
            label={t('search.form.skipVerify')}
            hint={
              search.skipVerify
                ? t('connection.tls.require.hint')
                : t('connection.tls.verifyFull.hint')
            }
          />
          {info.capabilities.clientCertificate && (
            <TlsClientFields
              draft={draft}
              keyLocation={sshSecretLocations.tlsKeyPassphrase ?? null}
              keychainAvailable={keychainAvailable}
              onChange={onChange}
              onPick={onPickTlsFile}
            />
          )}
        </>
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
