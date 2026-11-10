import { useId, useState } from 'react';

import { useT } from '../../i18n/useT';
import type { FilterOp, TableDataInfo } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Popover } from '../../ui/Popover';
import styles from './FilterBar.module.css';
import { FilterChipButton } from './FilterChipButton';
import { FilterForm } from './FilterForm';
import { EMPTY_FILTER, isFiltered, operatorsFor, type FilterState } from './filterModel';
import { useFilterRequests } from './filterRequests';
import { applyFilter, gridOf } from './tableActions';
import { useTableSessionStore } from './tableSessionStore';
import { useTableTabStore } from './tableTabStore';

/**
 * The filter bar of a table tab (F-081): conditions as chips (built in a small form), a raw
 * `WHERE` with what the engine said about it, and "Clear". Applying asks first when pending
 * changes would be lost.
 */
export function FilterBar({ tabId, info }: { tabId: string; info: TableDataInfo }) {
  const t = useT();
  const id = useId();
  const filter = useTableTabStore((state) => state.tabs[tabId]?.filter) ?? EMPTY_FILTER;
  const whereError = useTableSessionStore((state) => state.sessions[tabId]?.whereError ?? null);
  const request = useFilterRequests((state) => state.requests[tabId] ?? 0);
  const [raw, setRaw] = useState(filter.rawWhere);
  const [adding, setAdding] = useState(false);
  const [startColumn, setStartColumn] = useState<string | null>(null);

  // The applied condition changed elsewhere (Clear, a restored tab): the field follows.
  const [applied, setApplied] = useState(filter.rawWhere);
  if (applied !== filter.rawWhere) {
    setApplied(filter.rawWhere);
    setRaw(filter.rawWhere);
  }

  // `Mod+F`: a new condition, on the column of the focused cell.
  const [seenRequest, setSeenRequest] = useState(request);
  if (seenRequest !== request) {
    setSeenRequest(request);
    const grid = gridOf(tabId);
    const focus = grid?.selection()?.focus;
    const dataCol = focus ? grid.order()[focus.col] : undefined;
    setStartColumn(dataCol === undefined ? null : (info.columns[dataCol]?.name ?? null));
    setAdding(true);
  }

  const apply = (next: FilterState) => {
    void applyFilter(tabId, next);
  };

  const first = info.columns.find((c) => c.name === startColumn) ?? info.columns[0];
  const firstOp: FilterOp = first ? (operatorsFor(first)[0] ?? 'eq') : 'eq';

  return (
    <div className={styles.bar} role="search" aria-label={t('tableData.filter.label')}>
      <Icon name="filter" className={styles.icon} />
      {filter.chips.map((chip, index) => (
        <FilterChipButton
          // Chips have no identity of their own: their place is theirs.
          key={`${String(index)}:${chip.column}`}
          chip={chip}
          columns={info.columns}
          onChange={(next) => {
            apply({ ...filter, chips: filter.chips.map((c, i) => (i === index ? next : c)) });
          }}
          onRemove={() => {
            apply({ ...filter, chips: filter.chips.filter((_, i) => i !== index) });
          }}
        />
      ))}
      <Popover
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setStartColumn(null);
        }}
        align="start"
        trigger={
          <Button size="sm" variant="ghost" className={styles.add}>
            <Icon name="plus" />
            {t('tableData.filter.add')}
          </Button>
        }
      >
        {first && (
          <FilterForm
            key={`${String(request)}:${first.name}`}
            columns={info.columns}
            initial={{ column: first.name, op: firstOp, values: [] }}
            submitLabel={t('tableData.filter.apply')}
            onSubmit={(chip) => {
              setAdding(false);
              apply({ ...filter, chips: [...filter.chips, chip] });
            }}
            onCancel={() => {
              setAdding(false);
            }}
          />
        )}
      </Popover>
      <div className={styles.where}>
        <label className={styles.whereLabel} htmlFor={`${id}-where`}>
          WHERE
        </label>
        <input
          id={`${id}-where`}
          className={styles.whereInput}
          value={raw}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('tableData.filter.wherePlaceholder')}
          aria-label={t('tableData.filter.where')}
          aria-invalid={whereError ? true : undefined}
          aria-describedby={whereError ? `${id}-where-error` : undefined}
          onChange={(event) => {
            setRaw(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              apply({ ...filter, rawWhere: raw });
            } else if (event.key === 'Escape' && raw !== filter.rawWhere) {
              event.preventDefault();
              setRaw(filter.rawWhere);
            }
          }}
        />
        {whereError && (
          <div id={`${id}-where-error`} className={styles.whereError} role="alert">
            {whereError}
          </div>
        )}
      </div>
      {(isFiltered(filter) || raw !== '') && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setRaw('');
            apply(EMPTY_FILTER);
          }}
        >
          {t('tableData.filter.clear')}
        </Button>
      )}
    </div>
  );
}
