import { useId } from 'react';

import { useT } from '../../i18n/useT';
import { Disclosure } from '../../ui/Disclosure';
import { Field } from '../../ui/Field';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { ColorPicker } from './ColorPicker';
import styles from './ConnectionForm.module.css';
import { ENVIRONMENT_FIELDS, environmentSummary } from './connectionSections';
import { EnvTag } from './EnvTag';
import { ENVIRONMENTS, type ConnectionDraft, type DraftErrors, type EngineInfo } from './model';
import { defaultTagColor } from './tagColors';

interface EnvironmentSectionProps {
  draft: ConnectionDraft;
  info: EngineInfo | undefined;
  errors: DraftErrors;
  onChange: (patch: Partial<ConnectionDraft>) => void;
}

/**
 * The "Environment and safeguards" section of the connection form (F-007, F-008, F-104): the
 * environment that tints the connection, read-only and the history. Closed, its header names the
 * environment and the switches turned.
 */
export function EnvironmentSection({ draft, info, errors, onChange }: EnvironmentSectionProps) {
  const t = useT();
  const id = useId();
  const summary = environmentSummary(draft, t);
  const family = info?.capabilities.family;

  return (
    <Disclosure
      title={t('connection.section.environment')}
      icon="tag"
      summary={
        draft.environment === 'none' ? (
          summary.text
        ) : (
          <span className={styles.environmentSummary}>
            <EnvTag
              environment={draft.environment}
              label={draft.environmentLabel.trim() || null}
              tint={draft.environmentColor}
            />
            {summary.details.length > 0 && <span>{summary.details.join(' · ')}</span>}
          </span>
        )
      }
      summaryText={summary.text}
      modified={summary.modified}
      modifiedLabel={t('connection.section.modified')}
      forceOpen={errors.environmentLabel !== undefined}
      fields={ENVIRONMENT_FIELDS}
      data-testid="environment-section"
    >
      <Field label={t('connection.environment')} hint={t('connection.environment.hint')}>
        <SegmentedControl
          label={t('connection.environment')}
          value={draft.environment}
          options={ENVIRONMENTS.map((environment) => ({
            value: environment,
            label: t(`environment.${environment}`),
          }))}
          onChange={(environment) => {
            onChange({
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
              data-field="environmentLabel"
              value={draft.environmentLabel}
              maxLength={24}
              invalid={errors.environmentLabel !== undefined}
              placeholder="QA"
              onChange={(event) => {
                onChange({ environmentLabel: event.target.value });
              }}
            />
          </Field>
          <Field label={t('connection.color')}>
            <ColorPicker
              label={t('connection.environment.color')}
              value={draft.environmentColor}
              onChange={(environmentColor) => {
                onChange({ environmentColor });
              }}
            />
          </Field>
        </div>
      )}
      <Switch
        checked={draft.readOnly}
        onCheckedChange={(readOnly) => {
          onChange({ readOnly });
        }}
        label={t('connection.readOnly')}
        hint={
          family === 'keyValue'
            ? t('keyValue.form.readOnlyHint')
            : family === 'search'
              ? t('search.form.readOnlyHint')
              : info && !info.capabilities.readOnlySession
                ? t('connection.readOnly.hintClassifierOnly', { engine: info.label })
                : t('connection.readOnly.hint')
        }
      />
      <Switch
        checked={draft.historyEnabled}
        onCheckedChange={(historyEnabled) => {
          onChange({ historyEnabled });
        }}
        label={t('connection.history')}
        hint={t('connection.history.hint')}
      />
    </Disclosure>
  );
}
