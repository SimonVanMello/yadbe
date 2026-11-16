import { useId, type ReactNode } from 'react';

import { useT } from '../../i18n/useT';
import type { SecretLocation } from '../../ipc';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { TextInput } from '../../ui/TextInput';
import styles from './ConnectionForm.module.css';
import { EngineFields } from './EngineFields';
import { EnvironmentSection } from './EnvironmentSection';
import type { FormFrame } from './FamilyLayout';
import { TimeoutFields } from './TimeoutFields';
import type { SshHopName, SshSecretLocations } from './sshModel';
import {
  engineInfoOf,
  suggestedName,
  patchDraft,
  withEngine,
  type ConnectionDraft,
  type ConnectionGroup,
  type DraftErrors,
  type EngineInfo,
} from './model';

interface ConnectionFormProps {
  draft: ConnectionDraft;
  engines: readonly EngineInfo[];
  groups: readonly ConnectionGroup[];
  errors: DraftErrors;
  passwordLocation: SecretLocation | null;
  keychainAvailable: boolean;
  onChange: (draft: ConnectionDraft) => void;
  onPasteConnectionString: (text: string) => void;
  /** Picks another database file with the native picker (file engines). */
  onPickFile: () => void;
  /** Where the SSH secrets of the connection being edited are kept. */
  sshSecretLocations?: SshSecretLocations;
  /** Picks the private key file of an SSH hop with the native picker. */
  onPickKey?: (hop: SshHopName) => void;
  /** Picks the TLS client certificate or its key with the native picker. */
  onPickTlsFile?: (file: 'cert' | 'key') => void;
  /** The connection string field, beside the engine: pasting one fills the form. */
  connectionString?: ReactNode;
  /** What reading the pasted string said (an error, the keys left out), under that row. */
  connectionStringFeedback?: ReactNode;
}

/**
 * The connection form (F-001, F-005 to F-009, F-014): the engine, what connecting needs in the
 * common case and the name, open; environment, TLS, SSH tunnel and advanced options in sections
 * closed by default, whose headers say what they hold (`FamilyLayout`).
 */
export function ConnectionForm({
  draft,
  engines,
  groups,
  errors,
  passwordLocation,
  keychainAvailable,
  onChange,
  onPasteConnectionString,
  onPickFile,
  sshSecretLocations = {},
  onPickKey = () => undefined,
  onPickTlsFile = () => undefined,
  connectionString,
  connectionStringFeedback,
}: ConnectionFormProps) {
  const t = useT();
  const id = useId();
  const patch = (changes: Partial<ConnectionDraft>) => {
    onChange(patchDraft(draft, changes));
  };
  const info = engineInfoOf(engines, draft.engine);

  const frame: FormFrame = {
    identity: (
      <div className={styles.row}>
        <Field label={t('connection.name')} htmlFor={`${id}-name`}>
          <TextInput
            id={`${id}-name`}
            value={draft.name}
            placeholder={suggestedName(draft, info) || t('connection.name.placeholder')}
            onChange={(event) => {
              patch({ name: event.target.value });
            }}
          />
        </Field>
        <Field label={t('connection.group')} htmlFor={`${id}-group`}>
          <Select
            id={`${id}-group`}
            value={draft.groupId ?? ''}
            options={[
              { value: '', label: t('connection.group.none') },
              ...groups.map((group) => ({ value: group.id, label: group.name })),
            ]}
            onChange={(groupId) => {
              patch({ groupId: groupId === '' ? null : groupId });
            }}
          />
        </Field>
      </div>
    ),
    environment: <EnvironmentSection draft={draft} info={info} errors={errors} onChange={patch} />,
    timeouts: info && (
      <TimeoutFields draft={draft} fileEngine={info.capabilities.usesFile} onChange={patch} />
    ),
  };

  return (
    <div className={styles.form}>
      <div className={connectionString ? styles.topRow : undefined}>
        <Field label={t('connection.engine')} htmlFor={`${id}-engine`}>
          <Select
            id={`${id}-engine`}
            data-field="engine"
            value={draft.engine}
            options={engines.map((engine) => ({ value: engine.engine, label: engine.label }))}
            onChange={(engine) => {
              const next = engineInfoOf(engines, engine);
              if (next) onChange(withEngine(draft, next, info));
            }}
          />
        </Field>
        {connectionString}
      </div>
      {connectionStringFeedback}
      {info && !info.available && (
        <p className={styles.notice} role="note">
          {t('connection.engine.unavailable', { engine: info.label })}
        </p>
      )}

      {info ? (
        <EngineFields
          frame={frame}
          draft={draft}
          info={info}
          errors={errors}
          passwordLocation={passwordLocation}
          keychainAvailable={keychainAvailable}
          sshSecretLocations={sshSecretLocations}
          onChange={patch}
          onPasteConnectionString={onPasteConnectionString}
          onPickFile={onPickFile}
          onPickKey={onPickKey}
          onPickTlsFile={onPickTlsFile}
        />
      ) : (
        <>
          {frame.identity}
          {frame.environment}
        </>
      )}
    </div>
  );
}
