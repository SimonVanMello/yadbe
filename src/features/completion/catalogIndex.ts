import type {
  CatalogForeignKey,
  CatalogRelation,
  CatalogRoutine,
  CompletionCatalog,
} from '../../ipc';
import { NameList } from './nameList';

/** A foreign key seen from one of its two relations. */
export interface RelationLink {
  /** Columns of this relation, and of `other`, in key order. */
  columns: string[];
  other: number;
  otherColumns: string[];
  /** This relation holds the foreign key (it references `other`). */
  outgoing: boolean;
}

/**
 * The completion catalog indexed for the editor: names sorted for prefix lookups, relations by
 * name for resolving what a statement mentions, links between relations. Built once per
 * catalog (a few milliseconds for 10 000 objects), then only read.
 */
export class CatalogIndex {
  readonly database: string;
  private readonly schemaByLower = new Map<string, number>();
  private readonly pathSchemas: number[];
  private readonly relationsByLower = new Map<string, number[]>();
  private readonly routinesByLower = new Map<string, number[]>();
  private allRelationList: NameList | null = null;
  private allRoutineList: NameList | null = null;
  private columnList: NameList | null = null;
  private columnOwner: number[] = [];
  private readonly relationsBySchema = new Map<number, NameList>();
  private readonly routinesBySchema = new Map<number, NameList>();
  private linkCache: Map<number, RelationLink[]> | null = null;
  readonly schemaList: NameList;

  constructor(readonly catalog: CompletionCatalog) {
    this.database = catalog.database;
    catalog.schemas.forEach((schema, i) => {
      this.schemaByLower.set(schema.name.toLowerCase(), i);
    });
    this.pathSchemas = catalog.searchPath.flatMap((name) => {
      const index = this.schemaByLower.get(name.toLowerCase());
      return index === undefined ? [] : [index];
    });
    catalog.relations.forEach((relation, i) => {
      const key = relation.name.toLowerCase();
      const list = this.relationsByLower.get(key);
      if (list) list.push(i);
      else this.relationsByLower.set(key, [i]);
    });
    catalog.routines.forEach((routine, i) => {
      const key = routine.name.toLowerCase();
      const list = this.routinesByLower.get(key);
      if (list) list.push(i);
      else this.routinesByLower.set(key, [i]);
    });
    this.schemaList = new NameList(
      catalog.schemas.map((schema, id) => ({ name: schema.name, id })),
    );
  }

  /** Builds the sorted lists now, so that the first keystroke does not pay for them. */
  warm(): this {
    for (const list of [this.relations, this.routines, this.columnNames]) list.search('', 0);
    return this;
  }

  get hasSchemas(): boolean {
    return this.catalog.schemas.length > 0;
  }

  relation(index: number): CatalogRelation | undefined {
    return this.catalog.relations[index];
  }

  routine(index: number): CatalogRoutine | undefined {
    return this.catalog.routines[index];
  }

  schemaName(schema: number | null): string | null {
    return schema === null ? null : (this.catalog.schemas[schema]?.name ?? null);
  }

  schemaIndex(name: string): number | null {
    return this.schemaByLower.get(name.toLowerCase()) ?? null;
  }

  isSystemSchema(index: number): boolean {
    return this.catalog.schemas[index]?.system ?? false;
  }

  /** Every relation, by name. */
  get relations(): NameList {
    this.allRelationList ??= new NameList(
      this.catalog.relations.map((relation, id) => ({ name: relation.name, id })),
    );
    return this.allRelationList;
  }

  /** The relations of one schema (`null`: of a database without schemas). */
  relationsIn(schema: number | null): NameList {
    if (schema === null) return this.relations;
    let list = this.relationsBySchema.get(schema);
    if (!list) {
      const entries: { name: string; id: number }[] = [];
      this.catalog.relations.forEach((relation, id) => {
        if (relation.schema === schema) entries.push({ name: relation.name, id });
      });
      list = new NameList(entries);
      this.relationsBySchema.set(schema, list);
    }
    return list;
  }

  get routines(): NameList {
    this.allRoutineList ??= new NameList(
      this.catalog.routines.map((routine, id) => ({ name: routine.name, id })),
    );
    return this.allRoutineList;
  }

  routinesIn(schema: number | null): NameList {
    if (schema === null) return this.routines;
    let list = this.routinesBySchema.get(schema);
    if (!list) {
      const entries: { name: string; id: number }[] = [];
      this.catalog.routines.forEach((routine, id) => {
        if (routine.schema === schema) entries.push({ name: routine.name, id });
      });
      list = new NameList(entries);
      this.routinesBySchema.set(schema, list);
    }
    return list;
  }

  /** Distinct column names of the whole database, for columns of relations the statement lacks. */
  get columnNames(): NameList {
    if (!this.columnList) {
      const seen = new Map<string, number>();
      const entries: { name: string; id: number }[] = [];
      this.catalog.relations.forEach((relation, relationIndex) => {
        if (relation.kind === 'view' || relation.kind === 'materializedView') return;
        for (const name of relation.columns) {
          if (seen.has(name)) continue;
          const id = entries.length;
          seen.set(name, id);
          entries.push({ name, id });
          this.columnOwner.push(relationIndex);
        }
      });
      this.columnList = new NameList(entries);
    }
    return this.columnList;
  }

  /** A relation that has the column `columnNames` item `id` stands for. */
  ownerOfColumn(id: number): number | undefined {
    return this.columnOwner[id];
  }

  /**
   * The relation a statement means by `path`: `[name]` on the search path (the first schema that
   * has it wins), `[schema, name]`, `[database, schema, name]`. Names match as written first,
   * then without regard to case (unquoted names are folded by the engine). -1 when unknown.
   */
  resolve(path: readonly string[]): number {
    const name = path.at(-1);
    if (name === undefined) return -1;
    const candidates = this.relationsByLower.get(name.toLowerCase()) ?? [];
    if (candidates.length === 0) return -1;
    const exact = (indices: number[]): number =>
      indices.find((i) => this.catalog.relations[i]?.name === name) ?? indices[0] ?? -1;
    if (path.length === 1) {
      const onPath = this.firstOnPath(candidates);
      if (onPath.length > 0) return exact(onPath);
      return exact(candidates);
    }
    const schemaName = path.at(-2) ?? '';
    const schema = this.schemaByLower.get(schemaName.toLowerCase());
    if (schema === undefined) {
      // Without schemas, `database.table`.
      if (!this.hasSchemas && path.length === 2) return exact(candidates);
      return -1;
    }
    return exact(candidates.filter((i) => this.catalog.relations[i]?.schema === schema));
  }

  /** The candidates in the first schema of the search path that has one. */
  private firstOnPath(candidates: number[]): number[] {
    if (!this.hasSchemas) return candidates;
    for (const schema of this.pathSchemas) {
      const here = candidates.filter((i) => this.catalog.relations[i]?.schema === schema);
      if (here.length > 0) return here;
    }
    return [];
  }

  /** Whether writing `relation`'s name alone would not reach it. */
  needsSchema(relation: number): boolean {
    const entry = this.catalog.relations[relation];
    if (!entry || entry.schema === null) return false;
    const candidates = this.relationsByLower.get(entry.name.toLowerCase()) ?? [];
    return !this.firstOnPath(candidates).includes(relation);
  }

  /** Same for a routine: only its schema matters (overloads share a name). */
  routineNeedsSchema(routine: number): boolean {
    const entry = this.catalog.routines[routine];
    if (!entry || entry.schema === null) return false;
    return !this.pathSchemas.includes(entry.schema);
  }

  /** Foreign keys that start or end at `relation`. */
  linksOf(relation: number): RelationLink[] {
    if (!this.linkCache) {
      const cache = new Map<number, RelationLink[]>();
      const add = (key: number, link: RelationLink) => {
        const list = cache.get(key);
        if (list) list.push(link);
        else cache.set(key, [link]);
      };
      for (const key of this.catalog.foreignKeys) {
        const columnsOf = (side: number, indices: number[]): string[] =>
          indices.flatMap((i) => this.catalog.relations[side]?.columns[i] ?? []);
        add(key.from, {
          columns: columnsOf(key.from, key.fromColumns),
          other: key.to,
          otherColumns: columnsOf(key.to, key.toColumns),
          outgoing: true,
        });
        add(key.to, {
          columns: columnsOf(key.to, key.toColumns),
          other: key.from,
          otherColumns: columnsOf(key.from, key.fromColumns),
          outgoing: false,
        });
      }
      this.linkCache = cache;
    }
    return this.linkCache.get(relation) ?? [];
  }

  /** The foreign key of `relation`'s column `column`, if it is part of one. */
  foreignKeyOf(relation: number, column: string): CatalogForeignKey | undefined {
    const columns = this.catalog.relations[relation]?.columns ?? [];
    const position = columns.indexOf(column);
    if (position < 0) return undefined;
    return this.catalog.foreignKeys.find(
      (key) => key.from === relation && key.fromColumns.includes(position),
    );
  }
}
