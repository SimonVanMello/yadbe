import { useId, useState, type SyntheticEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { FilterOp, TableColumn } from '../../ipc';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { TextInput } from '../../ui/TextInput';
import { formatHint } from './cellValues';
import { arity, chipValues, operatorsFor, splitList, type FilterChip } from './filterModel';
import styles from './FilterBar.module.css';

interface FilterFormProps {
  columns: readonly TableColumn[];
  initial: FilterChip;
  submitLabel: string;
  onSubmit: (chip: FilterChip) => void;
  onCancel: () => void;
}

/**
 * One filter condition (F-081): a column, an operator that fits its kind, and typed values
 * (two for `between`, a list for `in`, none for `is null`), checked before it is applied.
 */
export function FilterForm({ columns, initial, submitLabel, onSubmit, onCancel }: FilterFormProps) {
  const t = useT();
  const id = useId();
  const [columnName, setColumnName] = useState(initial.column);
  const column = columns.find((c) => c.name === columnName) ?? columns[0];
  const operators = column ? operatorsFor(column) : [];
  const [chosenOp, setOp] = useState<FilterOp>(initial.op);
  const op = operators.includes(chosenOp) ? chosenOp : (operators[0] ?? 'eq');
  const [values, setValues] = useState<string[]>(initial.op === 'in' ? [] : initial.values);
  const [list, setList] = useState(initial.op === 'in' ? initial.values.join('\n') : '');
  const [touched, setTouched] = useState(false);
  if (!column) return null;

  // A boolean or an enum compared with `=` starts on its first choice.
  const choice =
    op === 'eq' || op === 'ne'
      ? column.kind === 'bool'
        ? 'true'
        : (column.enumValues?.[0] ?? null)
      : null;
  const valueAt = (index: number) => values[index] ?? choice ?? '';
  const count = Math.min(arity(op)[1], 2);
  const chip: FilterChip = {
    column: column.name,
    op,
    values: op === 'in' ? splitList(list) : Array.from({ length: count }, (_, i) => valueAt(i)),
  };
  const check = chipValues(chip, column);
  const error = !check.ok && touched ? t(check.error, check.params) : null;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (check.ok) onSubmit(chip);
  };

  const setValue = (index: number, value: string) => {
    setValues((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });
  };

  const valueInput = (
    index: number,
    labelKey: 'tableData.filter.value' | 'tableData.filter.from' | 'tableData.filter.to',
  ) => {
    const label = t(labelKey);
    const value = valueAt(index);
    if ((op === 'eq' || op === 'ne') && column.kind === 'bool') {
      return (
        <Select<string>
          aria-label={label}
          value={value}
          options={[
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
          onChange={(next) => {
            setValue(index, next);
          }}
        />
      );
    }
    if ((op === 'eq' || op === 'ne') && column.enumValues) {
      return (
        <Select<string>
          aria-label={label}
          value={value}
          options={column.enumValues.map((name) => ({ value: name, label: name }))}
          onChange={(next) => {
            setValue(index, next);
          }}
        />
      );
    }
    return (
      <TextInput
        mono
        aria-label={label}
        placeholder={formatHint(column.kind) ?? label}
        value={value}
        invalid={!!error && !check.ok && check.index === index}
        onChange={(event) => {
          setValue(index, event.target.value);
        }}
      />
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-label={t('tableData.filter.form')}>
      <label className={styles.formLabel} htmlFor={`${id}-column`}>
        {t('tableData.filter.column')}
      </label>
      <Select<string>
        id={`${id}-column`}
        value={column.name}
        options={columns.map((c) => ({ value: c.name, label: `${c.name} · ${c.typeName}` }))}
        onChange={(name) => {
          setColumnName(name);
          setValues([]);
          setTouched(false);
        }}
      />
      <label className={styles.formLabel} htmlFor={`${id}-op`}>
        {t('tableData.filter.operator')}
      </label>
      <Select<FilterOp>
        id={`${id}-op`}
        value={op}
        options={operators.map((value) => ({ value, label: t(`tableData.op.${value}`) }))}
        onChange={(next) => {
          setOp(next);
          setTouched(false);
        }}
      />
      {op === 'in' ? (
        <>
          <label className={styles.formLabel} htmlFor={`${id}-list`}>
            {t('tableData.filter.list')}
          </label>
          <textarea
            id={`${id}-list`}
            className={styles.list}
            rows={4}
            spellCheck={false}
            value={list}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setList(event.target.value);
            }}
          />
        </>
      ) : op === 'between' ? (
        <div className={styles.between}>
          {valueInput(0, 'tableData.filter.from')}
          <span className={styles.and}>{t('tableData.filter.and')}</span>
          {valueInput(1, 'tableData.filter.to')}
        </div>
      ) : arity(op)[1] > 0 ? (
        valueInput(0, 'tableData.filter.value')
      ) : null}
      {error && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.formButtons}>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" variant="primary">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
