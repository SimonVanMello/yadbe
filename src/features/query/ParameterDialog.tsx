import { useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { ParameterKind, ParameterValue, QueryParameter } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Select } from '../../ui/Select';
import { TextInput } from '../../ui/TextInput';
import styles from './ParameterDialog.module.css';
import {
  initialValue,
  isValidValue,
  parameterLabel,
  useParameterStore,
  type RememberedValue,
} from './parameterStore';

const KINDS: readonly ParameterKind[] = ['text', 'number', 'boolean', 'dateTime', 'null'];

interface FormProps {
  tabId: string;
  parameters: QueryParameter[];
}

function ParameterForm({ tabId, parameters }: FormProps) {
  const t = useT();
  const [values, setValues] = useState<RememberedValue[]>(() =>
    parameters.map((parameter) => initialValue(tabId, parameter)),
  );
  const valid = values.map((v) => isValidValue(v.kind, v.value));
  const canRun = valid.every(Boolean);
  const settle = useParameterStore((state) => state.settle);

  const update = (index: number, change: Partial<RememberedValue>) => {
    setValues((current) =>
      current.map((value, i) => {
        if (i !== index) return value;
        const next = { ...value, ...change };
        // A boolean starts from a valid value: the field becomes a choice.
        if (change.kind === 'boolean' && !isValidValue('boolean', next.value)) next.value = 'true';
        return next;
      }),
    );
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canRun) return;
    const out: ParameterValue[] = parameters.map((parameter, i) => ({
      name: parameter.name,
      kind: values[i]?.kind ?? 'text',
      value: values[i]?.value ?? '',
    }));
    settle(out);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
      title={t(parameters.length === 1 ? 'query.params.title.one' : 'query.params.title', {
        count: parameters.length,
      })}
      description={t('query.params.description')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              settle(null);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="query-params-form" disabled={!canRun}>
            {t('query.params.run')}
          </Button>
        </>
      }
    >
      <form
        id="query-params-form"
        className={styles.form}
        onSubmit={submit}
        data-testid="parameter-form"
      >
        <div className={styles.head} aria-hidden="true">
          <span>{t('query.params.name')}</span>
          <span>{t('query.params.type')}</span>
          <span>{t('query.params.value')}</span>
        </div>
        {parameters.map((parameter, index) => {
          const value = values[index] ?? { kind: 'text', value: '' };
          const id = `query-param-${String(index)}`;
          const label = parameterLabel(parameter);
          const uses = parameter.occurrences.length;
          return (
            <div key={parameter.name} className={styles.row}>
              <label htmlFor={id} className={styles.name} title={label}>
                <code>{label}</code>
                {uses > 1 && (
                  <span className={styles.uses}>{t('query.params.uses', { count: uses })}</span>
                )}
              </label>
              <Select<ParameterKind>
                aria-label={t('query.params.typeOf', { name: label })}
                value={value.kind}
                options={KINDS.map((kind) => ({
                  value: kind,
                  label: t(`query.params.kind.${kind}`),
                }))}
                onChange={(kind) => {
                  update(index, { kind });
                }}
              />
              {value.kind === 'boolean' ? (
                <Select<'true' | 'false'>
                  id={id}
                  value={/^(true|1|t|yes)$/i.test(value.value.trim()) ? 'true' : 'false'}
                  options={[
                    { value: 'true', label: 'true' },
                    { value: 'false', label: 'false' },
                  ]}
                  onChange={(next) => {
                    update(index, { value: next });
                  }}
                />
              ) : (
                <TextInput
                  id={id}
                  mono
                  autoFocus={index === 0}
                  disabled={value.kind === 'null'}
                  value={value.kind === 'null' ? 'NULL' : value.value}
                  placeholder={value.kind === 'dateTime' ? 'YYYY-MM-DD HH:MM:SS' : undefined}
                  aria-invalid={valid[index] === false}
                  onChange={(event) => {
                    update(index, { value: event.target.value });
                  }}
                />
              )}
              {valid[index] === false && (
                <span className={styles.invalid} role="alert">
                  {t(`query.params.invalid.${value.kind === 'number' ? 'number' : 'dateTime'}`)}
                </span>
              )}
            </div>
          );
        })}
      </form>
    </Dialog>
  );
}

/** The prompt for the values of a run's query parameters (F-048), when one is pending. */
export function ParameterDialog() {
  const pending = useParameterStore((state) => state.pending);
  if (!pending) return null;
  return (
    <ParameterForm key={pending.tabId} tabId={pending.tabId} parameters={pending.parameters} />
  );
}
