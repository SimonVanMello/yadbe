import type {
  ForeignKey,
  IncomingForeignKey,
  KeyValue,
  ObjectRef,
  Value,
  ValueKind,
} from '../../ipc';
import { valueText } from '../grid/rowSource';
import type { FilterState } from './filterModel';

/**
 * Foreign key navigation (F-088), the pure part: which key a cell belongs to, the key a value
 * designates, the filter a jump puts on the target tab, what a lookup choice writes, and the
 * columns that describe a referenced row.
 */

export function sameTable(a: ObjectRef, b: ObjectRef): boolean {
  return a.database === b.database && a.schema === b.schema && a.name === b.name;
}

/** The foreign keys a column belongs to, single-column ones first. */
export function foreignKeysOf(keys: readonly ForeignKey[], column: string): ForeignKey[] {
  return keys
    .filter((key) => key.columns.includes(column))
    .sort((a, b) => a.columns.length - b.columns.length);
}

/**
 * The key a foreign key value designates in the referenced table, one entry per column of the
 * key. `null` when a part is NULL (or unknown): the value then references no row.
 */
export function referencedKey(
  fk: ForeignKey,
  valueOf: (column: string) => Value | undefined,
): KeyValue[] | null {
  const key: KeyValue[] = [];
  for (const [index, column] of fk.columns.entries()) {
    const value = valueOf(column);
    const referenced = fk.referencedColumns[index];
    if (!value || value.kind === 'null' || referenced === undefined) return null;
    key.push({ column: referenced, value });
  }
  return key.length > 0 ? key : null;
}

/**
 * The key of the rows that reference a row through an incoming foreign key: their columns
 * equal this row's referenced columns. `null` when a referenced value is NULL.
 */
export function referencingKey(
  incoming: IncomingForeignKey,
  valueOf: (column: string) => Value | undefined,
): KeyValue[] | null {
  const { columns, referencedColumns } = incoming.foreignKey;
  const key: KeyValue[] = [];
  for (const [index, referenced] of referencedColumns.entries()) {
    const value = valueOf(referenced);
    const column = columns[index];
    if (!value || value.kind === 'null' || column === undefined) return null;
    key.push({ column, value });
  }
  return key.length > 0 ? key : null;
}

/** The filter a navigation puts on its target: one visible `=` chip per key column. */
export function keyFilter(key: readonly KeyValue[]): FilterState {
  return {
    chips: key.map((part) => ({
      column: part.column,
      op: 'eq',
      values: [valueText(part.value) ?? ''],
    })),
    rawWhere: '',
  };
}

/** `id = 7`, `invoice_id = 3, line_no = 2`: a key as the user reads it. */
export function describeKey(key: readonly KeyValue[]): string {
  return key.map((part) => `${part.column} = ${valueText(part.value) ?? 'NULL'}`).join(', ');
}

/**
 * What choosing a row in the foreign key editor writes: every column of the key takes the
 * value of the referenced column it maps to (a composite key is filled at once). Columns the
 * chosen row lacks are left out.
 */
export function compositeFill(
  fk: ForeignKey,
  chosen: (referencedColumn: string) => Value | undefined,
): { column: string; value: Value }[] {
  return fk.columns.flatMap((column, index) => {
    const referenced = fk.referencedColumns[index];
    const value = referenced === undefined ? undefined : chosen(referenced);
    return value === undefined ? [] : [{ column, value }];
  });
}

export interface DescribableColumn {
  name: string;
  kind: ValueKind;
  typeName: string;
}

/** Names that describe a row for a person, best first. */
const NAME_LIKE = [
  /^(display_?|full_?|user_?|company_?|product_?)?name$/i,
  /^(title|label|caption|subject|heading)$/i,
  /^(user_?name|login|email|e_?mail)$/i,
  /^(code|slug|sku|reference|number|ref)$/i,
  /(name|title|label)$/i,
];

/** Text that does not describe a row, or that a person should not see in a list. */
const NOT_DESCRIPTIVE = /(password|passwd|hash|salt|secret|token|key$|_id$|^id$|uuid|json|body)/i;

/** Text-like columns: text kinds, and the engine types shown as text (domains, enums…). */
function textLike(column: DescribableColumn): boolean {
  if (column.kind === 'text') return true;
  return column.kind === 'other' && /char|text|citext|name|email|enum/i.test(column.typeName);
}

function nameRank(name: string): number {
  const rank = NAME_LIKE.findIndex((pattern) => pattern.test(name));
  return rank < 0 ? NAME_LIKE.length : rank;
}

/**
 * The columns the foreign key editor shows next to the key (`max` at most): a unique
 * name-like text column first, then name-like ones, then the other unique texts, then the
 * first text columns of the table; never the key itself, secrets or JSON bodies. Without any
 * text column, the first non-key column of a readable kind, if any.
 */
export function descriptiveColumns(
  columns: readonly DescribableColumn[],
  keyColumns: readonly string[],
  uniqueKeys: readonly (readonly string[])[],
  max = 2,
): string[] {
  const unique = new Set(uniqueKeys.filter((key) => key.length === 1).map((key) => key[0] ?? ''));
  const candidates = columns
    .map((column, position) => ({ column, position }))
    .filter(
      ({ column }) =>
        !keyColumns.includes(column.name) && textLike(column) && !NOT_DESCRIPTIVE.test(column.name),
    );
  const score = ({ column, position }: (typeof candidates)[number]) => {
    const rank = nameRank(column.name);
    const named = rank < NAME_LIKE.length;
    // Lower is better: unique name-like, name-like, unique, other texts; then by rank, position.
    const tier = named ? (unique.has(column.name) ? 0 : 1) : unique.has(column.name) ? 2 : 3;
    return [tier, named ? rank : 0, position] as const;
  };
  const chosen = candidates
    .sort((a, b) => {
      const [ta, ra, pa] = score(a);
      const [tb, rb, pb] = score(b);
      return ta - tb || ra - rb || pa - pb;
    })
    .slice(0, max)
    .map(({ column }) => column.name);
  if (chosen.length > 0 || max === 0) return chosen;
  const readable: ValueKind[] = ['int', 'decimal', 'date', 'timestamp', 'timestampTz', 'uuid'];
  const fallback = columns.find(
    (column) => !keyColumns.includes(column.name) && readable.includes(column.kind),
  );
  return fallback ? [fallback.name] : [];
}
