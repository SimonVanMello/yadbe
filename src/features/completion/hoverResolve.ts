import type { CatalogIndex } from './catalogIndex';
import { analyze } from './completionContext';
import { relationColumns } from './completionOptions';
import { tokenize, type QuoteRules, type Token } from './sqlTokens';

/**
 * What the name under the pointer stands for (F-052), resolved like the autocomplete resolves
 * what is typed: aliases and CTEs of the statement, schemas, the search path or default schema.
 * Pure: the catalog index is the shared cache's, nothing is asked of the backend.
 */
export type HoverTarget =
  | { kind: 'relation'; relation: number }
  | { kind: 'column'; relation: number; column: string }
  | { kind: 'routine'; routine: number };

export interface HoverHit {
  target: HoverTarget;
  /** The name's range in the document. */
  from: number;
  to: number;
}

export interface HoverInput {
  /** Text of the statement under the pointer. */
  text: string;
  /** Offset of `text` in the document. */
  base: number;
  /** The pointer, as a document offset. */
  pos: number;
  rules: QuoteRules;
  index: CatalogIndex;
}

const isName = (token: Token | undefined): token is Token =>
  token?.kind === 'word' || token?.kind === 'quoted';

const isDot = (token: Token | undefined): boolean => token?.kind === 'punct' && token.value === '.';

const same = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();

function columnOf(index: CatalogIndex, relation: number, name: string): string | null {
  const columns = index.relation(relation)?.columns ?? [];
  return columns.find((column) => column === name) ?? columns.find((c) => same(c, name)) ?? null;
}

function routineNamed(index: CatalogIndex, path: string[]): number {
  const name = path.at(-1);
  if (name === undefined) return -1;
  const schema = path.length > 1 ? index.schemaIndex(path.at(-2) ?? '') : null;
  for (let id = 0; ; id++) {
    const routine = index.routine(id);
    if (!routine) return -1;
    if (!same(routine.name, name)) continue;
    if (schema === null || routine.schema === schema) return id;
  }
}

export function resolveHover(input: HoverInput): HoverHit | null {
  const { text, base, pos, rules, index } = input;
  const tokens = tokenize(text, rules);
  const at = pos - base;
  // Inside a name, else right after one (a cursor at the end of a word).
  let hit = tokens.findIndex((t) => isName(t) && t.from <= at && at < t.to);
  if (hit < 0) hit = tokens.findIndex((t) => isName(t) && t.to === at);
  const token = tokens[hit];
  if (!token || !isName(token)) return null;
  if (token.kind === 'word' && token.value.startsWith('@')) return null;

  // The qualified name up to the hovered part: `public.orders` when `orders` is hovered.
  const path = [token.value];
  let k = hit;
  while (isDot(tokens[k - 1]) && isName(tokens[k - 2])) {
    path.unshift(tokens[k - 2]?.value ?? '');
    k -= 2;
  }
  const next = tokens[hit + 1];
  const calls = next?.kind === 'punct' && next.value === '(';
  const range = { from: base + token.from, to: base + token.to };
  const done = (target: HoverTarget | null): HoverHit | null =>
    target ? { target, ...range } : null;

  const ctx = analyze({
    text,
    base,
    cursor: base + token.to,
    rules,
    columnsOf: (p) => relationColumns(index, p),
  });
  const name = token.value;
  const qualifiers = path.slice(0, -1);

  if (calls) {
    const routine = routineNamed(index, path);
    return routine < 0 ? null : done({ kind: 'routine', routine });
  }

  if (qualifiers.length > 0) {
    // `alias.column`, `table.column`.
    const owner = qualifiers.at(-1) ?? '';
    const scoped = ctx.relations.find((r) => same(r.visible, owner));
    if (scoped) {
      if (scoped.path === null) return null;
      const relation = index.resolve(scoped.path);
      const column = relation < 0 ? null : columnOf(index, relation, name);
      return relation < 0 || column === null ? null : done({ kind: 'column', relation, column });
    }
    // `schema.table`, `db.schema.table`.
    const relation = index.resolve(path);
    if (relation >= 0) return done({ kind: 'relation', relation });
    // `schema.table.column`, `table.column` of a table the statement does not alias.
    const table = index.resolve(qualifiers);
    const column = table < 0 ? null : columnOf(index, table, name);
    return table < 0 || column === null ? null : done({ kind: 'column', relation: table, column });
  }

  // An alias or a table name the statement reads from: its relation.
  const alias = ctx.relations.find((r) => same(r.visible, name) && r.path !== null);
  if (alias?.path && ctx.kind !== 'relation') {
    const relation = index.resolve(alias.path);
    if (relation >= 0) return done({ kind: 'relation', relation });
  }
  if (ctx.kind !== 'relation') {
    // A column of a relation in scope, the innermost select first.
    for (const scoped of ctx.relations) {
      if (scoped.path === null) continue;
      const relation = index.resolve(scoped.path);
      const column = relation < 0 ? null : columnOf(index, relation, name);
      if (column !== null) return done({ kind: 'column', relation, column });
    }
  }
  if (ctx.ctes.some((cte) => same(cte, name))) return null;
  const relation = index.resolve(path);
  return relation < 0 ? null : done({ kind: 'relation', relation });
}
