import { ServerFields } from './ServerFields';
import { SqliteFields } from './SqliteFields';
import { SshFields } from './SshFields';
import type { EngineFieldsProps } from './EngineFields';

/**
 * The engine fields of the SQL family: the database file of a file engine, else the server
 * address, login and TLS with the SSH tunnel (F-001, F-005, F-009, F-010).
 */
export function SqlConnectionFields({
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
  if (info.capabilities.usesFile) {
    return (
      <SqliteFields draft={draft} errors={errors} onChange={onChange} onPickFile={onPickFile} />
    );
  }
  return (
    <>
      <ServerFields
        draft={draft}
        info={info}
        errors={errors}
        passwordLocation={passwordLocation}
        keychainAvailable={keychainAvailable}
        tlsKeyLocation={sshSecretLocations.tlsKeyPassphrase ?? null}
        onPickTlsFile={onPickTlsFile}
        onChange={onChange}
        onPasteConnectionString={onPasteConnectionString}
      />
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
