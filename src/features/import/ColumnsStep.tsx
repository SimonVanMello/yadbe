import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore, type MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ImportColumnCheck, ImportConvertOptions } from '../../ipc';
import { Field } from '../../ui/Field';
import { Select, type SelectOption } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import {
  checkOf,
  messageOfIssue,
  usesKind,
  writable,
  type ColumnPlan,
  type SourceChoice,
} from './importModel';
import styles from './ImportDialog.module.css';
import type { ImportWizard } from './useImportWizard';

/** `skip`, `null`, `constant` or `file:<index>`: a choice as a `<select>` value. */
function encode(choice: SourceChoice): string {
  return choice.kind === 'file' ? `file:${String(choice.index)}` : choice.kind;
}

function decode(value: string, previous: SourceChoice): SourceChoice {
  if (value.startsWith('file:')) return { kind: 'file', index: Number(value.slice(5)) };
  if (value === 'null') return { kind: 'null' };
  if (value === 'constant') {
    return { kind: 'constant', value: previous.kind === 'constant' ? previous.value : '' };
  }
  return { kind: 'skip' };
}

function CheckCell({ check, plan }: { check: ImportColumnCheck | undefined; plan: ColumnPlan }) {
  const t = useT();
  if (plan.choice.kind !== 'file') return <span className={styles.muted}>—</span>;
  if (!check) return <span className={styles.muted}>…</span>;
  if (check.invalid === 0) {
    return (
      <span className={styles.good}>
        {t('import.check.ok', { count: check.examined, nulls: check.nulls })}
      </span>
    );
  }
  return (
    <div className={styles.bad}>
      <span>{t('import.check.invalid', { count: check.invalid })}</span>
      <ul className={styles.samples}>
        {check.samples.slice(0, 3).map((sample) => (
          <li key={`${String(sample.line)}:${sample.value}`}>
            {sample.value === '' ? (
              // An empty field is read as NULL: shown as one, not as a quoted text value.
              <>
                {t('import.check.sampleLine', { line: sample.line })}{' '}
                <span className={styles.nullValue}>{t('import.preview.null')}</span>{' '}
                {t('import.check.sampleReason', { reason: t(messageOfIssue(sample.reason)) })}
              </>
            ) : (
              t('import.check.sample', {
                line: sample.line,
                value: sample.value,
                reason: t(messageOfIssue(sample.reason)),
              })
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Badges({ plan }: { plan: ColumnPlan }) {
  const t = useT();
  const { column } = plan;
  return (
    <span className={styles.badges}>
      {column.primaryKey && <span className={styles.badge}>{t('import.badge.pk')}</span>}
      {!column.nullable && <span className={styles.badge}>{t('import.badge.required')}</span>}
      {column.filledByServer && column.readOnlyReason === null && (
        <span className={styles.badge}>{t('import.badge.default')}</span>
      )}
    </span>
  );
}

/** Step 2: which file column is written to which table column, and whether it will convert. */
export function ColumnsStep({ wizard }: { wizard: ImportWizard }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const { preview, plans, analysis, analysisError, analyzing, missing, convert } = wizard;
  const fileColumns = preview?.columns ?? [];
  const fileOptions: SelectOption<string>[] = fileColumns.map((name, index) => ({
    value: `file:${String(index)}`,
    label: `${String(index + 1)}. ${name}`,
  }));
  const optionsFor = (plan: ColumnPlan): SelectOption<string>[] => [
    { value: 'skip', label: t('import.source.skip') },
    ...fileOptions,
    ...(plan.column.nullable ? [{ value: 'null', label: t('import.source.null') }] : []),
    { value: 'constant', label: t('import.source.constant') },
  ];
  const setConvert = (patch: Partial<ImportConvertOptions>) => {
    wizard.setConvert({ ...convert, ...patch });
  };

  return (
    <div className={styles.step}>
      {wizard.target?.readOnly && (
        <p className={styles.warning} role="alert">
          {t('import.target.readOnly')}
        </p>
      )}
      <div className={styles.mapWrap}>
        <div className={`${styles.mapRow} ${styles.mapHead}`} role="row">
          <span role="columnheader">{t('import.columns.table')}</span>
          <span role="columnheader">{t('import.columns.source')}</span>
          <span role="columnheader">{t('import.columns.check')}</span>
        </div>
        {plans.map((plan) => {
          const { column } = plan;
          const locked = !writable(column);
          return (
            <div
              key={column.name}
              className={styles.mapRow}
              role="row"
              data-locked={locked || undefined}
              data-testid={`map-${column.name}`}
            >
              <span className={styles.columnCell} role="cell">
                <span className={styles.columnName}>{column.name}</span>
                <span className={styles.columnType}>{column.typeName}</span>
                <Badges plan={plan} />
              </span>
              <span className={styles.sourceCell} role="cell">
                {locked ? (
                  <span className={styles.muted}>
                    {t(`import.readOnly.${column.readOnlyReason ?? 'table'}` as MessageKey)}
                  </span>
                ) : (
                  <>
                    <Select<string>
                      aria-label={t('import.columns.sourceOf', { column: column.name })}
                      value={encode(plan.choice)}
                      options={optionsFor(plan)}
                      onChange={(value) => {
                        wizard.setChoice(column.name, decode(value, plan.choice));
                      }}
                    />
                    {plan.choice.kind === 'constant' && (
                      <TextInput
                        mono
                        aria-label={t('import.source.constantOf', { column: column.name })}
                        value={plan.choice.value}
                        placeholder={t('import.source.constantPlaceholder')}
                        onChange={(event) => {
                          wizard.setChoice(column.name, {
                            kind: 'constant',
                            value: event.target.value,
                          });
                        }}
                      />
                    )}
                  </>
                )}
              </span>
              <span className={styles.checkCell} role="cell">
                {locked ? (
                  <span className={styles.muted}>—</span>
                ) : (
                  <CheckCell check={checkOf(analysis, column.name)} plan={plan} />
                )}
              </span>
            </div>
          );
        })}
      </div>

      {(usesKind(plans, ['decimal', 'float']) || usesKind(plans, ['bytes'])) && (
        <div className={styles.options}>
          {usesKind(plans, ['decimal', 'float']) && (
            <Field label={t('import.convert.decimal')} htmlFor="import-decimal">
              <Select<'dot' | 'comma'>
                id="import-decimal"
                value={convert.decimalSeparator}
                options={[
                  { value: 'dot', label: t('import.convert.decimal.dot') },
                  { value: 'comma', label: t('import.convert.decimal.comma') },
                ]}
                onChange={(decimalSeparator) => {
                  setConvert({ decimalSeparator });
                }}
              />
            </Field>
          )}
          {usesKind(plans, ['bytes']) && (
            <Field label={t('import.convert.binary')} htmlFor="import-binary">
              <Select<'hex' | 'base64'>
                id="import-binary"
                value={convert.binary}
                options={[
                  { value: 'hex', label: t('export.binary.hex') },
                  { value: 'base64', label: t('export.binary.base64') },
                ]}
                onChange={(binary) => {
                  setConvert({ binary });
                }}
              />
            </Field>
          )}
        </div>
      )}

      <div className={styles.summary} role="status">
        {analyzing && <Spinner />}
        <span>
          {t('import.columns.summary', {
            mapped: wizard.mapped,
            total: plans.filter((p) => writable(p.column)).length,
            file: fileColumns.length,
          })}
        </span>
        {analysis && (
          <span className={styles.muted}>
            {analysis.sampled
              ? t('import.analysis.sampled', {
                  count: new Intl.NumberFormat(locale).format(analysis.rowsExamined),
                })
              : t('import.analysis.all', {
                  count: new Intl.NumberFormat(locale).format(analysis.rowsExamined),
                })}
          </span>
        )}
      </div>
      {missing.length > 0 && (
        <p className={styles.warning} role="alert">
          {t('import.columns.missing', { columns: missing.join(', ') })}
        </p>
      )}
      {analysis && analysis.raggedRows > 0 && (
        <p className={styles.warning} role="status">
          {t('import.warn.ragged', { count: analysis.raggedRows })}
        </p>
      )}
      {analysisError && (
        <ErrorPanel title={t('import.error.analysis')} error={analysisError} compact />
      )}
    </div>
  );
}
