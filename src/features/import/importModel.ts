import type { MessageKey } from '../../i18n/i18n';
import type {
  ImportAnalysis,
  ImportColumnCheck,
  ImportIssueKind,
  ImportMapping,
  ImportTargetColumn,
} from '../../ipc';

/** What a table column is written from. `skip`: left out, the server applies its default. */
export type SourceChoice =
  | { kind: 'skip' }
  | { kind: 'file'; index: number }
  | { kind: 'null' }
  | { kind: 'constant'; value: string };

export interface ColumnPlan {
  column: ImportTargetColumn;
  choice: SourceChoice;
}

/** A name compared without case, spaces, dashes or underscores (`Order ID` ~ `order_id`). */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s_\-.]+/g, '');
}

/** A column the import can write: not generated, not an identity the server always fills. */
export function writable(column: ImportTargetColumn): boolean {
  return column.readOnlyReason === null;
}

/**
 * Pairs the table's columns with the file's by name: the same name first, then the same name
 * once case and separators are ignored. A file column serves one table column. Columns with no
 * match are left to their default.
 */
export function autoMatch(
  fileColumns: readonly string[],
  target: readonly ImportTargetColumn[],
): ColumnPlan[] {
  const used = new Set<number>();
  const found = new Map<string, number>();
  const take = (column: ImportTargetColumn, same: (file: string) => boolean) => {
    if (found.has(column.name) || !writable(column)) return;
    const index = fileColumns.findIndex((name, i) => !used.has(i) && same(name));
    if (index >= 0) {
      used.add(index);
      found.set(column.name, index);
    }
  };
  for (const column of target) take(column, (file) => file.trim() === column.name);
  for (const column of target) {
    take(column, (file) => normalize(file) === normalize(column.name));
  }
  return target.map((column) => {
    const index = found.get(column.name);
    return { column, choice: index === undefined ? { kind: 'skip' } : { kind: 'file', index } };
  });
}

/**
 * The plans after the file's columns changed (another delimiter, another file): a file column
 * the user chose stays if a column of that name still exists, `NULL` and constants stay, the
 * rest is matched again by name.
 */
export function rematch(
  previous: readonly ColumnPlan[],
  oldColumns: readonly string[],
  newColumns: readonly string[],
  target: readonly ImportTargetColumn[],
): ColumnPlan[] {
  const fresh = autoMatch(newColumns, target);
  return fresh.map((plan, at) => {
    const before = previous[at]?.choice;
    if (before?.kind === 'null' || before?.kind === 'constant') return { ...plan, choice: before };
    if (before?.kind === 'file') {
      const name = oldColumns[before.index];
      const index = name === undefined ? -1 : newColumns.indexOf(name);
      if (index >= 0) return { ...plan, choice: { kind: 'file', index } };
    }
    return plan;
  });
}

/** The mapping the backend takes: every plan that writes something. */
export function toMapping(plans: readonly ColumnPlan[]): ImportMapping[] {
  return plans.flatMap((plan): ImportMapping[] => {
    switch (plan.choice.kind) {
      case 'skip':
        return [];
      case 'file':
        return [{ column: plan.column.name, source: { kind: 'file', index: plan.choice.index } }];
      case 'null':
        return [{ column: plan.column.name, source: { kind: 'null' } }];
      case 'constant':
        return [
          { column: plan.column.name, source: { kind: 'constant', value: plan.choice.value } },
        ];
    }
  });
}

/** `NOT NULL` columns without a default that nothing writes: the insert would fail. */
export function missingRequired(plans: readonly ColumnPlan[]): string[] {
  return plans
    .filter(
      (plan) =>
        plan.choice.kind === 'skip' &&
        writable(plan.column) &&
        !plan.column.nullable &&
        !plan.column.filledByServer,
    )
    .map((plan) => plan.column.name);
}

/** Whether a column of the file is written to more than one table column. */
export function duplicatedFileColumns(plans: readonly ColumnPlan[]): number[] {
  const counts = new Map<number, number>();
  for (const plan of plans) {
    if (plan.choice.kind === 'file') {
      counts.set(plan.choice.index, (counts.get(plan.choice.index) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n > 1).map(([index]) => index);
}

export function mappedCount(plans: readonly ColumnPlan[]): number {
  return plans.filter((plan) => plan.choice.kind !== 'skip').length;
}

/** Decimal separator and binary encoding only matter when a mapped column needs them. */
export function usesKind(plans: readonly ColumnPlan[], kinds: readonly string[]): boolean {
  return plans.some((plan) => plan.choice.kind !== 'skip' && kinds.includes(plan.column.kind));
}

export function messageOfIssue(reason: ImportIssueKind): MessageKey {
  return `import.issue.${reason}`;
}

/** Values that will not convert, across the mapped columns. */
export function invalidTotal(analysis: ImportAnalysis | null): number {
  return analysis?.columns.reduce((sum, check) => sum + check.invalid, 0) ?? 0;
}

export function checkOf(
  analysis: ImportAnalysis | null,
  column: string,
): ImportColumnCheck | undefined {
  return analysis?.columns.find((check) => check.column === column);
}

/** Size above which one transaction is a real cost (locks, transaction log). */
export const LARGE_FILE_BYTES = 256 * 1024 * 1024;

export function isLargeFile(bytes: number | null): boolean {
  return bytes !== null && bytes >= LARGE_FILE_BYTES;
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The path of the rejects file proposed next to the import file: `orders-rejected.csv`. */
export function rejectsName(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}-rejected.csv`;
}
