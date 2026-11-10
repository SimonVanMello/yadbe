import { useState } from 'react';

import { useT } from '../../i18n/useT';
import type { TableColumn } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { Popover } from '../../ui/Popover';
import { describeChip, type FilterChip } from './filterModel';
import styles from './FilterBar.module.css';
import { FilterForm } from './FilterForm';

interface FilterChipButtonProps {
  chip: FilterChip;
  columns: readonly TableColumn[];
  onChange: (chip: FilterChip) => void;
  onRemove: () => void;
}

/** An applied condition: click to change it, × to remove it. */
export function FilterChipButton({ chip, columns, onChange, onRemove }: FilterChipButtonProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const text = describeChip(chip, {
    and: t('tableData.filter.and'),
    opLabel: (op) => t(`tableData.opShort.${op}`),
  });
  const known = columns.some((c) => c.name === chip.column);
  return (
    <span className={styles.chip} data-unknown={!known || undefined}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="start"
        trigger={
          <button
            type="button"
            className={styles.chipText}
            title={known ? text : t('tableData.filter.unknownColumn', { column: chip.column })}
          >
            {text}
          </button>
        }
      >
        <FilterForm
          columns={columns}
          initial={chip}
          submitLabel={t('tableData.filter.apply')}
          onSubmit={(next) => {
            setOpen(false);
            onChange(next);
          }}
          onCancel={() => {
            setOpen(false);
          }}
        />
      </Popover>
      <button
        type="button"
        className={styles.chipRemove}
        aria-label={t('tableData.filter.remove', { filter: text })}
        onClick={onRemove}
      >
        <Icon name="close" />
      </button>
    </span>
  );
}
