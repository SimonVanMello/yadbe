import type { SecretLocation } from '../../ipc';
import { DocumentConnectionFields } from './DocumentConnectionFields';
import type { ConnectionDraft, DraftErrors, EngineInfo } from './model';
import { KeyValueConnectionFields } from './KeyValueConnectionFields';
import { SqlConnectionFields } from './SqlConnectionFields';
import type { SshHopName, SshSecretLocations } from './sshModel';

/** What the connection form gives the fields of an engine family. */
export interface EngineFieldsProps {
  draft: ConnectionDraft;
  info: EngineInfo;
  errors: DraftErrors;
  passwordLocation: SecretLocation | null;
  keychainAvailable: boolean;
  /** Where the SSH and TLS key secrets of the connection being edited are kept. */
  sshSecretLocations: SshSecretLocations;
  onChange: (patch: Partial<ConnectionDraft>) => void;
  /** Pasted text that looks like a connection string: the form fills itself from it. */
  onPasteConnectionString: (text: string) => void;
  /** Picks another database file with the native picker (file engines). */
  onPickFile: () => void;
  /** Picks the private key file of an SSH hop with the native picker. */
  onPickKey: (hop: SshHopName) => void;
  /** Picks the TLS client certificate or its key with the native picker. */
  onPickTlsFile: (file: 'cert' | 'key') => void;
}

/**
 * The fields that say where and how to connect, chosen by the engine's family; the name, group,
 * environment and timeouts around them are common to every family. A family gets its
 * connection form by adding its case here.
 */
export function EngineFields(props: EngineFieldsProps) {
  switch (props.info.capabilities.family) {
    case 'sql':
      return <SqlConnectionFields {...props} />;
    case 'document':
      return <DocumentConnectionFields {...props} />;
    case 'keyValue':
      return <KeyValueConnectionFields {...props} />;
    default:
      return null;
  }
}
