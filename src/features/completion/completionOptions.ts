import type { CatalogIndex } from './catalogIndex';
import type { CompletionContext, ScopeRelation } from './completionContext';
import { quoteIfNeeded, type Quoting } from './identifierQuoting';
import { matchScore, NameList, PREFIX_SCORE } from './nameList';
import { boostedKeywords, type Vocabulary } from './sqlVocabulary';

/**
 * What to suggest for a context: pure ranking over the catalog index and the dialect's
 * vocabulary, free of CodeMirror so that it can be tested and measured on its own.
 */

export type SuggestionKind =
  | 'table'
  | 'view'
  | 'materializedView'
  | 'schema'
  | 'column'
  | 'function'
  | 'procedure'
  | 'keyword'
  | 'type'
  | 'alias'
  | 'cte'
  | 'join';

/** What the info panel shows for a suggestion. */
export type SuggestionInfo =
  | { type: 'relation'; relation: number }
  | { type: 'column'; relation: number | null; column: string; typeName: string | null }
  | { type: 'routine'; routine: number }
  | { type: 'columns'; name: string; columns: { name: string; typeName: string | null }[] };

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  /** Type for columns, schema for relations. */
  detail: string;
  /** The text that replaces the typed word. */
  insert: string;
  /** Cursor position inside `insert`, counted from its end (a function's parentheses). */
  cursorBack: number;
  /** Ask for suggestions again after inserting (`schema.`, `alias.`). */
  follow: boolean;
  score: number;
  /** Position among columns, to keep the table's own order when nothing is typed. */
  order?: number;
  info: SuggestionInfo | null;
}

export const DEFAULT_LIMIT = 60;

/** Context boosts stay below the gap between the match tiers (1000), so match quality still leads. */
const BOOST = {
  scopeColumn: 600,
  outerColumn: 450,
  join: 800,
  alias: 350,
  cte: 300,
  schema: -100,
  system: -400,
  catalogFunction: 100,
  keyword: -100,
  keywordNext: 400,
  otherColumn: -300,
} as const;

/** Most catalog columns offered from relations the statement does not mention. */
const OTHER_COLUMNS = 15;

const RELATION_CLAUSES = new Set(['from', 'join', 'into', 'update', 'using', 'table', 'truncate']);

type VocabularyPart = 'keywords' | 'functions' | 'types';

const lists = new WeakMap<Vocabulary, Record<VocabularyPart, NameList>>();

function listsOf(vocabulary: Vocabulary): Record<VocabularyPart, NameList> {
  let found = lists.get(vocabulary);
  if (!found) {
    const make = (words: readonly string[]) =>
      new NameList(words.map((name, id) => ({ name, id })));
    found = {
      keywords: make(vocabulary.keywords),
      functions: make(vocabulary.functions),
      types: make(vocabulary.types),
    };
    lists.set(vocabulary, found);
  }
  return found;
}

const sameName = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();

interface Column {
  name: string;
  typeName: string | null;
}

interface ColumnSource {
  /** The catalog relation the columns belong to, `null` for a CTE or subquery. */
  relation: number | null;
  columns: Column[];
}

function columnsOfRelation(index: CatalogIndex, relation: number): ColumnSource {
  const entry = index.relation(relation);
  const columns = (entry?.columns ?? []).map((name, position) => {
    const typeIndex = entry?.columnTypes[position];
    return {
      name,
      typeName: typeIndex === undefined ? null : (index.catalog.typeNames[typeIndex] ?? null),
    };
  });
  return { relation, columns };
}

/** Column names of a catalog relation, or `null` when it is unknown. */
export function relationColumns(index: CatalogIndex | null, path: string[]): string[] | null {
  if (!index) return null;
  const found = index.resolve(path);
  return found < 0 ? null : (index.relation(found)?.columns ?? null);
}

function columnsOfScope(index: CatalogIndex | null, relation: ScopeRelation): ColumnSource {
  if (relation.path === null) {
    return {
      relation: null,
      columns: (relation.columns ?? []).map((name) => ({ name, typeName: null })),
    };
  }
  const found = index ? index.resolve(relation.path) : -1;
  return index && found >= 0 ? columnsOfRelation(index, found) : { relation: null, columns: [] };
}

function relationKind(index: CatalogIndex, relation: number): SuggestionKind {
  const kind = index.relation(relation)?.kind;
  return kind === 'view' || kind === 'materializedView' ? kind : 'table';
}

class Collector {
  private readonly items: Suggestion[] = [];
  private readonly query: string;

  constructor(
    readonly ctx: CompletionContext,
    readonly quoting: Quoting,
    readonly index: CatalogIndex | null,
  ) {
    this.query = ctx.prefix.toLowerCase();
  }

  /** The name as it is written at the cursor: quoted when needed, or raw inside an open quote. */
  written(name: string): string {
    const { close } = this.quoting;
    if (this.ctx.quoted) return name.split(close).join(close + close) + close;
    return quoteIfNeeded(name, this.quoting);
  }

  /** `schema.name` when the schema has to be said, else `name`. */
  writtenIn(schema: string | null, name: string, qualify: boolean): string {
    if (qualify && schema !== null && !this.ctx.quoted) {
      return `${quoteIfNeeded(schema, this.quoting)}.${this.written(name)}`;
    }
    return this.written(name);
  }

  add(item: Pick<Suggestion, 'label' | 'kind' | 'score'> & Partial<Suggestion>): void {
    this.items.push({
      detail: '',
      insert: item.label,
      cursorBack: 0,
      follow: false,
      info: null,
      ...item,
    });
  }

  /**
   * Adds `name` if it matches what is typed, scored with `boost` on top. With nothing typed,
   * `order` (the column's position) replaces "shorter first": a table's columns stay in order.
   */
  addMatching(
    name: string,
    boost: number,
    build: () => Pick<Suggestion, 'label' | 'kind'> & Partial<Suggestion>,
    order?: number,
  ): void {
    const ordered = order !== undefined && this.query === '';
    const score = ordered ? PREFIX_SCORE : matchScore(name, name.toLowerCase(), this.query);
    if (score > 0) this.add({ ...build(), score: score + boost, ...(ordered ? { order } : {}) });
  }

  result(limit: number): Suggestion[] {
    return this.items
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.order ?? 0) - (b.order ?? 0) ||
          a.label.length - b.label.length ||
          (a.label < b.label ? -1 : 1),
      )
      .slice(0, limit);
  }
}

function addRelations(collector: Collector, list: NameList, qualified: boolean, limit: number) {
  const { index, ctx } = collector;
  if (!index) return;
  for (const { id, score } of list.search(ctx.prefix, limit)) {
    const relation = index.relation(id);
    if (!relation) continue;
    const system = relation.schema !== null && index.isSystemSchema(relation.schema);
    const schema = index.schemaName(relation.schema);
    collector.add({
      label: relation.name,
      kind: relationKind(index, id),
      detail: schema ?? '',
      insert: collector.writtenIn(schema, relation.name, !qualified && index.needsSchema(id)),
      score: score + (system ? BOOST.system : 0),
      info: { type: 'relation', relation: id },
    });
  }
}

function addRoutines(collector: Collector, list: NameList, qualified: boolean, limit: number) {
  const { index, ctx } = collector;
  if (!index) return;
  for (const { id, score } of list.search(ctx.prefix, limit)) {
    const routine = index.routine(id);
    if (!routine) continue;
    const system = routine.schema !== null && index.isSystemSchema(routine.schema);
    const schema = index.schemaName(routine.schema);
    const name = collector.writtenIn(
      schema,
      routine.name,
      !qualified && index.routineNeedsSchema(id),
    );
    const procedure = routine.kind === 'procedure';
    collector.add({
      label: routine.name,
      kind: procedure ? 'procedure' : 'function',
      detail: routine.returnType ?? schema ?? '',
      insert: procedure ? name : `${name}()`,
      cursorBack: procedure ? 0 : 1,
      score: score + (system ? BOOST.system : BOOST.catalogFunction),
      info: { type: 'routine', routine: id },
    });
  }
}

function addColumns(collector: Collector, source: ColumnSource, boost: number) {
  source.columns.forEach(({ name, typeName }, position) => {
    collector.addMatching(
      name,
      boost,
      () => ({
        label: name,
        kind: 'column',
        detail: typeName ?? '',
        insert: collector.written(name),
        info: { type: 'column', relation: source.relation, column: name, typeName },
      }),
      position,
    );
  });
}

function addSchemas(collector: Collector, limit: number) {
  const { index, ctx } = collector;
  if (!index?.hasSchemas) return;
  for (const { id, name, score } of index.schemaList.search(ctx.prefix, limit)) {
    collector.add({
      label: name,
      kind: 'schema',
      insert: ctx.quoted ? collector.written(name) : `${collector.written(name)}.`,
      follow: !ctx.quoted,
      score: score + (index.isSystemSchema(id) ? BOOST.system : BOOST.schema),
    });
  }
}

function addVocabulary(
  collector: Collector,
  vocabulary: Vocabulary,
  part: VocabularyPart,
  next: ReadonlyMap<string, number> | null,
  limit: number,
) {
  const { prefix } = collector.ctx;
  const query = prefix.toLowerCase();
  // `SEL` is answered in capitals, like what was typed.
  const shout = prefix.length > 1 && prefix === prefix.toUpperCase();
  const call = part === 'functions';
  const kind = part === 'keywords' ? 'keyword' : call ? 'function' : 'type';
  const push = (name: string, score: number) => {
    const cased = shout ? name.toUpperCase() : name;
    const rank = next?.get(name);
    collector.add({
      label: cased,
      kind,
      insert: call ? `${cased}()` : cased,
      cursorBack: call ? 1 : 0,
      score: score + (rank === undefined ? BOOST.keyword : BOOST.keywordNext - rank * 8),
    });
  };
  // The words that fit the position come first even when the alphabet would cut them off.
  const listed = new Set<string>();
  for (const word of next?.keys() ?? []) {
    const score = matchScore(word, word, query);
    if (score > 0) push(word, score);
    listed.add(word);
  }
  for (const { name, score } of listsOf(vocabulary)[part].search(prefix, limit)) {
    if (!listed.has(name)) push(name, score);
  }
}

function addQualified(collector: Collector, limit: number) {
  const { ctx, index } = collector;
  const { qualifiers } = ctx;
  const relationOnly = ctx.clause !== null && RELATION_CLAUSES.has(ctx.clause);
  const objectsOf = (schema: number | null) => {
    if (!index || schema === null) return;
    addRelations(collector, index.relationsIn(schema), true, limit);
    if (!relationOnly) addRoutines(collector, index.routinesIn(schema), true, limit);
  };
  const columnsOf = (path: string[]) => {
    const found = index && !relationOnly ? index.resolve(path) : -1;
    if (index && found >= 0) addColumns(collector, columnsOfRelation(index, found), 0);
  };
  const [first, second] = qualifiers;
  if (first === undefined) return;
  if (qualifiers.length === 1) {
    // A name the statement gives a relation wins over a schema or table of the same name.
    const alias = ctx.relations.find((relation) => sameName(relation.visible, first));
    if (alias) {
      addColumns(collector, columnsOfScope(index, alias), 0);
      return;
    }
    if (!index) return;
    objectsOf(index.schemaIndex(first));
    if (index.hasSchemas && sameName(index.database, first)) addSchemas(collector, limit);
    columnsOf([first]);
  } else if (qualifiers.length === 2 && second !== undefined) {
    if (index && sameName(index.database, first)) objectsOf(index.schemaIndex(second));
    columnsOf([first, second]);
  } else {
    columnsOf(qualifiers);
  }
}

/** `a.customer_id = b.id` for the foreign keys between the joined relation and the others. */
function addJoins(collector: Collector) {
  const { ctx, index } = collector;
  if (!index || ctx.clause !== 'on') return;
  const joined = ctx.relations.find((relation) => relation.joinedHere);
  const target = joined?.path ? index.resolve(joined.path) : -1;
  if (!joined || target < 0) return;
  for (const other of ctx.relations) {
    if (other === joined || !other.path) continue;
    const otherIndex = index.resolve(other.path);
    for (const link of index.linksOf(target)) {
      if (link.other !== otherIndex) continue;
      const text = link.columns
        .map(
          (column, i) =>
            `${joined.visible}.${column} = ${other.visible}.${link.otherColumns[i] ?? ''}`,
        )
        .join(' AND ');
      collector.addMatching(text, BOOST.join, () => ({ label: text, kind: 'join' }));
    }
  }
}

function addExpression(collector: Collector) {
  const { ctx, index } = collector;
  const sources = ctx.relations.map((relation) => ({
    relation,
    source: columnsOfScope(index, relation),
  }));
  // A column name that several relations of the statement have is written with its relation.
  const owners = new Map<string, number>();
  for (const { source } of sources) {
    for (const { name } of source.columns) {
      const key = name.toLowerCase();
      owners.set(key, (owners.get(key) ?? 0) + 1);
    }
  }
  sources.forEach(({ relation, source }, relationPosition) => {
    const boost = relation.depth === 0 ? BOOST.scopeColumn : BOOST.outerColumn;
    source.columns.forEach(({ name, typeName }, position) => {
      const shared = (owners.get(name.toLowerCase()) ?? 0) > 1;
      collector.addMatching(
        name,
        boost,
        () => ({
          label: name,
          kind: 'column',
          detail: shared
            ? [relation.visible, typeName].filter(Boolean).join(' · ')
            : (typeName ?? ''),
          insert: shared
            ? `${quoteIfNeeded(relation.visible, collector.quoting)}.${collector.written(name)}`
            : collector.written(name),
          info: { type: 'column', relation: source.relation, column: name, typeName },
        }),
        relationPosition * 1000 + position,
      );
    });
    // The name the statement gives the relation: `o` completes to `o.`.
    collector.addMatching(relation.visible, BOOST.alias - relation.depth * 50, () => ({
      label: relation.visible,
      kind: 'alias',
      detail: relation.path ? relation.path.join('.') : '',
      insert: `${collector.written(relation.visible)}.`,
      follow: true,
      info:
        source.relation === null
          ? { type: 'columns', name: relation.visible, columns: source.columns }
          : { type: 'relation', relation: source.relation },
    }));
  });
  if (!index) return;
  // Columns of relations the statement does not mention: once enough is typed to narrow them,
  // or at once while the statement has no relation yet (`SELECT na|` before the `FROM`).
  if (ctx.prefix.length < (ctx.hasRelations ? 2 : 1)) return;
  for (const { id, name, score } of index.columnNames.search(ctx.prefix, OTHER_COLUMNS)) {
    if (owners.has(name.toLowerCase())) continue;
    const owner = index.ownerOfColumn(id);
    collector.add({
      label: name,
      kind: 'column',
      detail: owner === undefined ? '' : (index.relation(owner)?.name ?? ''),
      insert: collector.written(name),
      score: score + (ctx.hasRelations ? BOOST.otherColumn : BOOST.keyword),
      info: { type: 'column', relation: owner ?? null, column: name, typeName: null },
    });
  }
}

/**
 * Suggestions for a context, best first. `index` is `null` while the catalog loads (or when it
 * cannot be read): the dialect's words are still offered.
 */
export function suggest(
  ctx: CompletionContext,
  index: CatalogIndex | null,
  vocabulary: Vocabulary,
  quoting: Quoting,
  limit = DEFAULT_LIMIT,
): Suggestion[] {
  const collector = new Collector(ctx, quoting, index);
  switch (ctx.kind) {
    case 'none':
      return [];
    case 'qualified':
      addQualified(collector, limit);
      break;
    case 'relation':
      if (index) {
        addRelations(collector, index.relations, false, limit);
        addSchemas(collector, 10);
      }
      for (const cte of ctx.ctes) {
        collector.addMatching(cte, BOOST.cte, () => ({
          label: cte,
          kind: 'cte',
          insert: collector.written(cte),
        }));
      }
      break;
    case 'columns':
      addJoins(collector);
      addExpression(collector);
      if (index) addRoutines(collector, index.routines, false, 20);
      addVocabulary(collector, vocabulary, 'functions', null, 20);
      addVocabulary(
        collector,
        vocabulary,
        'keywords',
        boostedKeywords('expression', ctx.clause),
        20,
      );
      break;
    case 'insertColumns': {
      const target = ctx.insertTarget && index ? index.resolve(ctx.insertTarget) : -1;
      if (index && target >= 0) {
        addColumns(collector, columnsOfRelation(index, target), BOOST.scopeColumn);
      }
      break;
    }
    case 'routine':
      if (index) addRoutines(collector, index.routines, false, limit);
      break;
    case 'keywords':
      if (ctx.clause === 'type') addVocabulary(collector, vocabulary, 'types', null, limit);
      else {
        const next = boostedKeywords(ctx.position, ctx.clause);
        addVocabulary(collector, vocabulary, 'keywords', next, limit);
      }
      break;
  }
  return collector.result(limit);
}
