import { useId } from 'react';

import { useT } from '../../i18n/useT';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { FamilyLayout } from './FamilyLayout';
import { ServerFields } from './ServerFields';
import { SqliteFields } from './SqliteFields';
import { SshFields } from './SshFields';
import { TlsClientFields } from './TlsClientFields';
import type { EngineFieldsProps } from './EngineFields';
import { TLS_MODES } from './model';

/**
 * The engine fields of the SQL family: the database file of a file engine, else the server
 * address and login, with TLS and the SSH tunnel in their sections (F-001, F-005, F-009, F-010).
 */
export function SqlConnectionFields({
  frame,
  draft,
  info,
  errors,
  passwordLocation,
  keychainAvailable,
  sshSecretLocations,
  onChange,
  onPasteConnectionString,
  onPickFile,
  onPickKey,
  onPickTlsFile,
}: EngineFieldsProps) {
  const t = useT();
  const id = useId();
  if (info.capabilities.usesFile) {
    return (
      <FamilyLayout
        frame={frame}
        draft={draft}
        info={info}
        essentials={
          <SqliteFields draft={draft} errors={errors} onChange={onChange} onPickFile={onPickFile} />
        }
      />
    );
  }
  return (
    <FamilyLayout
      frame={frame}
      draft={draft}
      info={info}
      essentials={
        <ServerFields
          draft={draft}
          errors={errors}
          passwordLocation={passwordLocation}
          keychainAvailable={keychainAvailable}
          onChange={onChange}
          onPasteConnectionString={onPasteConnectionString}
        />
      }
      tls={
        <>
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
          {info.capabilities.clientCertificate && draft.tlsMode !== 'disable' && (
            <TlsClientFields
              draft={draft}
              keyLocation={sshSecretLocations.tlsKeyPassphrase ?? null}
              keychainAvailable={keychainAvailable}
              onChange={onChange}
              onPick={onPickTlsFile}
            />
          )}
        </>
      }
      ssh={
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
      }
    />
  );
}
