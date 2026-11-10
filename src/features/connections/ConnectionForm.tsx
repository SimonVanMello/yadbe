import { useId } from 'react';

import { useT } from '../../i18n/useT';
import type { SecretLocation } from '../../ipc';
import { Field } from '../../ui/Field';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { ColorPicker } from './ColorPicker';
import styles from './ConnectionForm.module.css';
import { ServerFields } from './ServerFields';
import { defaultTagColor } from './tagColors';
import { SqliteFields } from './SqliteFields';
import {
  ENVIRONMENTS,
  suggestedName,
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
}

/** The connection form (F-001, F-005 to F-009): engine, engine-specific fields, identity. */
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
}: ConnectionFormProps) {
  const t = useT();
  const id = useId();
  const patch = (changes: Partial<ConnectionDraft>) => {
    onChange({ ...draft, ...changes });
  };
  const info = engines.find((candidate) => candidate.engine === draft.engine);

  return (
    <div className={styles.form}>
      <Field label={t('connection.engine')}>
        <SegmentedControl
          label={t('connection.engine')}
          value={draft.engine}
          options={engines.map((engine) => ({ value: engine.engine, label: engine.label }))}
          onChange={(engine) => {
            const next = engines.find((candidate) => candidate.engine === engine);
            if (next) onChange(withEngine(draft, next, info));
          }}
        />
      </Field>
      {info && !info.available && (
        <p className={styles.notice} role="note">
          {t('connection.engine.unavailable', { engine: info.label })}
        </p>
      )}

      {info?.capabilities.usesFile ? (
        <SqliteFields draft={draft} errors={errors} onChange={patch} onPickFile={onPickFile} />
      ) : (
        info && (
          <ServerFields
            draft={draft}
            info={info}
            errors={errors}
            passwordLocation={passwordLocation}
            keychainAvailable={keychainAvailable}
            onChange={patch}
            onPasteConnectionString={onPasteConnectionString}
          />
        )
      )}

      <hr className={styles.separator} />

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

      <Field label={t('connection.environment')} hint={t('connection.environment.hint')}>
        <SegmentedControl
          label={t('connection.environment')}
          value={draft.environment}
          options={ENVIRONMENTS.map((environment) => ({
            value: environment,
            label: t(`environment.${environment}`),
          }))}
          onChange={(environment) => {
            patch({
              environment,
              // A custom environment starts with a color, so it is never invisible.
              ...(environment === 'custom' && draft.environmentColor === null
                ? { environmentColor: defaultTagColor() }
                : {}),
            });
          }}
        />
      </Field>
      {draft.environment === 'custom' && (
        <div className={styles.row}>
          <Field
            label={t('connection.environment.label')}
            htmlFor={`${id}-env-label`}
            error={
              errors.environmentLabel ? t('connection.error.environmentLabelRequired') : undefined
            }
          >
            <TextInput
              id={`${id}-env-label`}
              value={draft.environmentLabel}
              maxLength={24}
              invalid={errors.environmentLabel !== undefined}
              placeholder="QA"
              onChange={(event) => {
                patch({ environmentLabel: event.target.value });
              }}
            />
          </Field>
          <Field label={t('connection.color')}>
            <ColorPicker
              label={t('connection.environment.color')}
              value={draft.environmentColor}
              onChange={(environmentColor) => {
                patch({ environmentColor });
              }}
            />
          </Field>
        </div>
      )}

      <Switch
        checked={draft.readOnly}
        onCheckedChange={(readOnly) => {
          patch({ readOnly });
        }}
        label={t('connection.readOnly')}
        hint={
          info && !info.capabilities.readOnlySession
            ? t('connection.readOnly.hintClassifierOnly', { engine: info.label })
            : t('connection.readOnly.hint')
        }
      />
    </div>
  );
}
