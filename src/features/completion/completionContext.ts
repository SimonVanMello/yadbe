import { insideLiteral, tokenize, type QuoteRules, type Token } from './sqlTokens';

/**
 * What the cursor is asking for, worked out from the tokens of the current statement alone (no
 * catalog, except through `columnsOf` to expand a `*`). The statement comes from the backend's
 * splitter (`statementAt`); this module never splits.
 */

/** A relation the statement reads from, as written in its `FROM` / `JOIN` / `UPDATE` / `INTO`. */
export interface ScopeRelation {
  /** The name the statement refers to it by: its alias, else its own name. */
  visible: string;
  /** Name parts for a table or view of the catalog (`['public', 'orders']`); `null` for a CTE or subquery. */
  path: string[] | null;
  /** Known columns of a CTE or subquery; `null` for catalog relations. */
  columns: string[] | null;
  /** 0 for the select the cursor is in, 1 for the one around it (correlated subqueries)… */
  depth: number;
  /** The relation introduced by the `JOIN` whose `ON` the cursor is in. */
  joinedHere: boolean;
}

export type ContextKind =
  /** Inside a string or a comment, or after something that is not a name. */
  | 'none'
  /** After `a.` or `a.b.`: members of a schema, columns of a relation. */
  | 'qualified'
  /** After `FROM`, `JOIN`, `INTO`, `UPDATE`…: a relation is expected. */
  | 'relation'
  /** Where an expression starts: columns, functions, keywords. */
  | 'columns'
  /** In the column list of `INSERT INTO t (…)`. */
  | 'insertColumns'
  /** After `EXEC` / `CALL`. */
  | 'routine'
  /** Keywords only: statement start, or after an operand (alias or next clause). */
  | 'keywords';

export interface CompletionContext {
  kind: ContextKind;
  /** What is typed of the word (without its opening quote). */
  prefix: string;
  /** Document range to replace on accept. */
  from: number;
  to: number;
  /** The cursor is inside a quoted name: the insertion is the raw name and the closing quote. */
  quoted: boolean;
  /** `a.b.` → `['a', 'b']`. */
  qualifiers: string[];
  /** Relations of the statement, the innermost select first. */
  relations: ScopeRelation[];
  /** The keyword of the clause the cursor is in (`select`, `from`, `where`, `by`, `set`…). */
  clause: string | null;
  /** `start`: a statement starts here; `operand`: something was just written, keywords follow. */
  position: 'start' | 'operand' | 'expression';
  /** For `insertColumns`: the table receiving the rows. */
  insertTarget: string[] | null;
  /** The statement mentions at least one relation. */
  hasRelations: boolean;
  /** Names of the CTEs in reach, offered where a relation is expected. */
  ctes: string[];
}

export interface AnalyzeInput {
  /** Text of the current statement. */
  text: string;
  /** Offset of `text` in the document. */
  base: number;
  /** Cursor, as a document offset. */
  cursor: number;
  rules: QuoteRules;
  /** Columns of a catalog relation, to expand `*` in a subquery's select list. */
  columnsOf: (path: string[]) => string[] | null;
}

const NONE: Omit<CompletionContext, 'from' | 'to'> = {
  kind: 'none',
  prefix: '',
  quoted: false,
  qualifiers: [],
  relations: [],
  clause: null,
  position: 'start',
  insertTarget: null,
  hasRelations: false,
  ctes: [],
};

/** Words that open a relation: after one, a table or view name is expected. */
const RELATION_KEYWORDS = new Set(['from', 'join', 'into', 'update', 'using', 'table', 'truncate']);

/** Words after which an expression starts. */
const EXPRESSION_KEYWORDS = new Set([
  'select',
  'distinct',
  'all',
  'where',
  'having',
  'on',
  'by',
  'set',
  'and',
  'or',
  'not',
  'in',
  'is',
  'like',
  'ilike',
  'between',
  'exists',
  'any',
  'some',
  'case',
  'when',
  'then',
  'else',
  'returning',
  'limit',
  'offset',
  'values',
  'escape',
  'similar',
  'interval',
]);

/** Words that cannot be the alias of a relation. */
const NOT_AN_ALIAS = new Set([
  'where',
  'on',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'outer',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'fetch',
  'union',
  'intersect',
  'except',
  'set',
  'using',
  'values',
  'returning',
  'select',
  'from',
  'window',
  'for',
  'lateral',
  'with',
  'tablesample',
  'straight_join',
  'partition',
  'into',
  'and',
  'or',
  'not',
  'default',
  'add',
  'drop',
  'alter',
  'rename',
  'truncate',
  'delete',
  'update',
  'insert',
  'when',
  'then',
  'else',
  'end',
  'as',
  'is',
  'in',
  'like',
  'between',
]);

/** Keywords that start a clause the backward scan stops at. */
const CLAUSE_KEYWORDS = new Set([
  'select',
  'from',
  'join',
  'using',
  'into',
  'update',
  'table',
  'truncate',
  'where',
  'having',
  'on',
  'by',
  'set',
  'values',
  'limit',
  'offset',
  'fetch',
  'returning',
  'exec',
  'execute',
  'call',
  'with',
  'union',
  'intersect',
  'except',
  'insert',
  'delete',
  'create',
  'alter',
  'drop',
]);

interface Scope {
  parent: Scope | null;
  /** Index of the `(` that opened it, -1 for the statement itself. */
  opener: number;
  /** Indices of the tokens at this level, the parentheses of children included. */
  own: number[];
  /** Index of the closing `)`; the token count when it never closed. */
  end: number;
  decls: Decl[];
  ctes: Cte[];
}

interface Decl {
  keyword: string;
  path: string[] | null;
  alias: string | null;
  derived: Scope | null;
  /** Position in `own` right after the declaration, to tell which `JOIN` an `ON` belongs to. */
  endPos: number;
}

interface Cte {
  name: string;
  body: Scope | null;
  columns: string[] | null;
}

type NameToken = Token & { kind: 'word' | 'quoted' };
const isIdent = (token: Token | undefined): token is NameToken =>
  token !== undefined && (token.kind === 'word' || token.kind === 'quoted');
const isPunct = (token: Token | undefined, value: string): boolean =>
  token !== undefined && token.kind === 'punct' && token.value === value;
const isWord = (token: Token | undefined, ...words: string[]): boolean =>
  token !== undefined && token.kind === 'word' && words.includes(token.lower);

/** Splits the tokens into parenthesis scopes. */
function buildScopes(tokens: Token[], limit: number, atToken: number) {
  const root: Scope = { parent: null, opener: -1, own: [], end: limit, decls: [], ctes: [] };
  const byOpener = new Map<number, Scope>();
  const all: Scope[] = [root];
  let current = root;
  let cursorScope: Scope | null = null;
  for (let i = 0; i < limit; i++) {
    if (i === atToken) cursorScope = current;
    const token = tokens[i];
    if (!token) continue;
    if (isPunct(token, '(')) {
      current.own.push(i);
      const child: Scope = { parent: current, opener: i, own: [], end: limit, decls: [], ctes: [] };
      byOpener.set(i, child);
      all.push(child);
      current = child;
    } else if (isPunct(token, ')') && current.parent) {
      current.end = i;
      current = current.parent;
      current.own.push(i);
    } else {
      current.own.push(i);
    }
  }
  if (atToken >= limit) cursorScope = current;
  return { root, all, byOpener, cursorScope: cursorScope ?? root };
}

class Analysis {
  constructor(
    readonly tokens: Token[],
    readonly scopes: ReturnType<typeof buildScopes>,
    readonly columnsOf: (path: string[]) => string[] | null,
    /** Index of the word being typed: it is not a declaration yet. */
    private readonly typing: number,
  ) {
    for (const scope of scopes.all) this.declare(scope);
  }

  private at(scope: Scope, pos: number): Token | undefined {
    const index = scope.own[pos];
    return index === undefined || index === this.typing ? undefined : this.tokens[index];
  }

  /** `FROM a x, b y JOIN c`, `UPDATE t`, `INSERT INTO t`, `WITH x AS (…)`: what the scope declares. */
  private declare(scope: Scope): void {
    for (let pos = 0; pos < scope.own.length; pos++) {
      const token = this.at(scope, pos);
      if (!token || token.kind !== 'word') continue;
      if (RELATION_KEYWORDS.has(token.lower)) {
        this.declareRelations(scope, pos + 1, token.lower);
      } else if (token.lower === 'with') {
        this.declareCtes(scope, pos + 1);
      }
    }
  }

  private declareRelations(scope: Scope, start: number, keyword: string): void {
    let pos = start;
    for (;;) {
      while (isWord(this.at(scope, pos), 'only', 'lateral')) pos++;
      const first = this.at(scope, pos);
      let path: string[] | null = null;
      let derived: Scope | null = null;
      // `JOIN … USING (a, b)` lists columns, it declares nothing.
      if (keyword === 'using' && isPunct(first, '(')) return;
      if (isPunct(first, '(')) {
        const opener = scope.own[pos];
        derived = (opener === undefined ? undefined : this.scopes.byOpener.get(opener)) ?? null;
        if (!derived) return;
        // Past the matching `)`, which is the next own token after the child's.
        pos += 2;
      } else if (isIdent(first)) {
        if (first.kind === 'word' && CLAUSE_KEYWORDS.has(first.lower)) return;
        path = [first.value];
        pos++;
        while (isPunct(this.at(scope, pos), '.') && isIdent(this.at(scope, pos + 1))) {
          path.push(this.at(scope, pos + 1)?.value ?? '');
          pos += 2;
        }
        // A function call (`generate_series(…)`) is not a relation of the catalog, and a
        // dangling dot is a name still being written.
        if (isPunct(this.at(scope, pos), '(') || isPunct(this.at(scope, pos), '.')) return;
      } else {
        return;
      }
      let alias: string | null = null;
      const bareAlias = keyword === 'from' || keyword === 'join' || keyword === 'using';
      const aliasAllowed = bareAlias || keyword === 'update';
      let candidate = this.at(scope, pos);
      if (isWord(candidate, 'as')) {
        pos++;
        candidate = this.at(scope, pos);
        if (isIdent(candidate)) {
          alias = candidate.value;
          pos++;
        }
      } else if (
        aliasAllowed &&
        isIdent(candidate) &&
        (candidate.kind === 'quoted' || !NOT_AN_ALIAS.has(candidate.lower))
      ) {
        alias = candidate.value;
        pos++;
      }
      scope.decls.push({ keyword, path, alias, derived, endPos: pos });
      if (bareAlias && keyword !== 'join' && isPunct(this.at(scope, pos), ',')) {
        pos++;
        continue;
      }
      return;
    }
  }

  private declareCtes(scope: Scope, start: number): void {
    let pos = start;
    if (isWord(this.at(scope, pos), 'recursive')) pos++;
    for (;;) {
      const name = this.at(scope, pos);
      if (!isIdent(name)) return;
      pos++;
      let columns: string[] | null = null;
      if (isPunct(this.at(scope, pos), '(')) {
        const opener = scope.own[pos];
        const list = opener === undefined ? undefined : this.scopes.byOpener.get(opener);
        if (!list) return;
        columns = list.own
          .map((i) => this.tokens[i])
          .filter(isIdent)
          .map((token) => token.value);
        pos += 2;
      }
      if (!isWord(this.at(scope, pos), 'as')) return;
      pos++;
      if (isWord(this.at(scope, pos), 'not')) pos++;
      if (isWord(this.at(scope, pos), 'materialized')) pos++;
      if (!isPunct(this.at(scope, pos), '(')) return;
      const opener = scope.own[pos];
      const body = (opener === undefined ? undefined : this.scopes.byOpener.get(opener)) ?? null;
      scope.ctes.push({ name: name.value, body, columns });
      pos += 2;
      if (isPunct(this.at(scope, pos), ',')) {
        pos++;
        continue;
      }
      return;
    }
  }

  private findCte(scope: Scope, name: string): Cte | null {
    const lower = name.toLowerCase();
    for (let s: Scope | null = scope; s; s = s.parent) {
      const found = s.ctes.find((cte) => cte.name.toLowerCase() === lower);
      if (found) return found;
    }
    return null;
  }

  /** Column names a `SELECT` list produces, for CTEs and derived tables. */
  private projection(scope: Scope, seen = new Set<Scope>()): string[] {
    if (seen.has(scope)) return [];
    seen.add(scope);
    const names: string[] = [];
    let pos = scope.own.findIndex((i) => isWord(this.tokens[i], 'select'));
    if (pos < 0) return names;
    pos++;
    while (isWord(this.at(scope, pos), 'distinct', 'all')) pos++;
    let item: Token[] = [];
    const flush = () => {
      this.projectItem(scope, item, names, seen);
      item = [];
    };
    for (; pos < scope.own.length; pos++) {
      const token = this.at(scope, pos);
      if (!token) break;
      if (token.kind === 'word' && token.lower === 'from') break;
      if (isPunct(token, ',')) {
        flush();
        continue;
      }
      if (isPunct(token, '(')) {
        // Skip the child scope: its `)` is the next own token.
        item.push(token);
        pos++;
        const close = this.at(scope, pos);
        if (close) item.push(close);
        continue;
      }
      item.push(token);
    }
    flush();
    return names;
  }

  private projectItem(scope: Scope, item: Token[], out: string[], seen: Set<Scope>): void {
    const last = item.at(-1);
    if (!last) return;
    const before = item.at(-2);
    if (isPunct(last, '*')) {
      const qualifier = isPunct(before, '.') ? item.at(-3) : undefined;
      for (const relation of this.declaredIn(scope, seen)) {
        if (qualifier && isIdent(qualifier) && !sameName(relation.visible, qualifier.value))
          continue;
        out.push(...(relation.columns ?? []));
      }
      return;
    }
    if (isIdent(last)) {
      if (isWord(before, 'as') || isPunct(before, '.') || item.length === 1) {
        out.push(last.value);
      } else if (before && (isIdent(before) || isPunct(before, ')') || before.kind === 'number')) {
        // Implicit alias: `count(*) total`.
        out.push(last.value);
      }
    }
  }

  /** Relations of one scope with their columns, for expanding `*`. */
  private declaredIn(scope: Scope, seen: Set<Scope>): ScopeRelation[] {
    return scope.decls.map((decl) => this.relationOf(scope, decl, 0, false, seen));
  }

  private relationOf(
    scope: Scope,
    decl: Decl,
    depth: number,
    joinedHere: boolean,
    seen: Set<Scope> = new Set(),
  ): ScopeRelation {
    const visible = decl.alias ?? decl.path?.at(-1) ?? '';
    if (decl.derived) {
      return {
        visible,
        path: null,
        columns: this.projection(decl.derived, seen),
        depth,
        joinedHere,
      };
    }
    const path = decl.path;
    if (path && path.length === 1) {
      const cte = this.findCte(scope, path[0] ?? '');
      if (cte) {
        const columns = cte.columns ?? (cte.body ? this.projection(cte.body, seen) : []);
        return { visible, path: null, columns, depth, joinedHere };
      }
    }
    return { visible, path, columns: path ? this.columnsOf(path) : null, depth, joinedHere };
  }

  /** Every relation visible from `scope`, innermost first. */
  visibleFrom(scope: Scope, joinPos: number | null): ScopeRelation[] {
    const out: ScopeRelation[] = [];
    let depth = 0;
    for (let s: Scope | null = scope; s; s = s.parent, depth++) {
      for (const decl of s.decls) {
        const joined =
          depth === 0 && joinPos !== null && decl.keyword === 'join' && decl.endPos === joinPos;
        out.push(this.relationOf(s, decl, depth, joined));
      }
    }
    return out;
  }

  /** CTE names visible from `scope`, for suggestions after `FROM`. */
  visibleCtes(scope: Scope): string[] {
    const names: string[] = [];
    for (let s: Scope | null = scope; s; s = s.parent)
      for (const cte of s.ctes) names.push(cte.name);
    return names;
  }
}

function sameName(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** Where the cursor stands among the tokens of its statement. */
interface Spot {
  /** Index of the word or quoted name being typed, or -1. */
  typing: number;
  /** Number of tokens before the cursor, not counting the one being typed. */
  left: number;
  /** Index of the first token after the one being typed. */
  right: number;
}

function locate(tokens: Token[], cursor: number): Spot | 'blocked' {
  let left = 0;
  let typing = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.from >= cursor) break;
    if (insideLiteral(token, cursor)) return 'blocked';
    if (token.to < cursor) {
      left = i + 1;
    } else if (token.kind === 'word') {
      typing = i;
    } else if (token.kind === 'quoted') {
      // Right after a closing quote nothing is being typed.
      if (token.closed && cursor === token.to) return 'blocked';
      typing = i;
    } else if (token.kind === 'number' || token.kind === 'param') {
      return 'blocked';
    } else {
      left = i + 1;
    }
  }
  return typing >= 0 ? { typing, left: typing, right: typing + 1 } : { typing, left, right: left };
}

interface FoundClause {
  word: string;
  /** Position in the scope's `own` list. */
  pos: number;
  scope: Scope;
}

/** The nearest clause keyword at the level of `scope`, among its tokens up to index `bound`. */
function findClause(tokens: Token[], scope: Scope, bound: number): FoundClause | null {
  for (let pos = scope.own.length - 1; pos >= 0; pos--) {
    const index = scope.own[pos] ?? -1;
    if (index > bound) continue;
    const token = tokens[index];
    if (token?.kind !== 'word' || !CLAUSE_KEYWORDS.has(token.lower)) continue;
    // `FOR UPDATE` and `ON UPDATE CASCADE` do not start an `UPDATE`.
    const before = tokens[scope.own[pos - 1] ?? -1];
    if (token.lower === 'update' && isWord(before, 'for', 'on'))
      return { word: 'limit', pos, scope };
    return { word: token.lower, pos, scope };
  }
  return null;
}

const RELATION_CLAUSES = new Set(['from', 'join', 'into', 'update', 'using', 'table', 'truncate']);
const EXPRESSION_CLAUSES = new Set(['select', 'where', 'having', 'on', 'by', 'set', 'returning']);
const KEYWORD_CLAUSES = new Set(['values', 'limit', 'offset', 'fetch', 'with']);
const STARTING_CLAUSES = new Set([
  'union',
  'intersect',
  'except',
  'insert',
  'delete',
  'create',
  'alter',
  'drop',
]);

export function analyze(input: AnalyzeInput): CompletionContext {
  const { text, base, cursor: docCursor, rules } = input;
  const cursor = docCursor - base;
  const tokens = tokenize(text, rules);
  const spot = locate(tokens, cursor);
  if (spot === 'blocked') return { ...NONE, from: docCursor, to: docCursor };

  let from = docCursor;
  let to = docCursor;
  let prefix = '';
  let quoted = false;
  const typed = spot.typing >= 0 ? tokens[spot.typing] : undefined;
  if (typed?.kind === 'word') {
    from = base + typed.from;
    // The rest of the word goes too: accepting `orders` in `ord|ers` must not leave `ers`.
    to = base + typed.to;
    prefix = text.slice(typed.from, cursor);
  } else if (typed?.kind === 'quoted') {
    quoted = true;
    from = base + typed.from + 1;
    to = base + (typed.closed ? typed.to : cursor);
    prefix = text
      .slice(typed.from + 1, cursor)
      .split(rules.close + rules.close)
      .join(rules.close);
  }
  const done = (
    partial: Partial<CompletionContext> & { kind: ContextKind },
  ): CompletionContext => ({ ...NONE, prefix, from, to, quoted, ...partial });

  // A `;` before the cursor starts a new statement, one after it ends this one: the splitter's
  // range may include its delimiter.
  let first = 0;
  for (let i = spot.left - 1; i >= 0; i--) {
    if (isPunct(tokens[i], ';')) {
      first = i + 1;
      break;
    }
  }
  let last = tokens.length;
  for (let i = spot.right; i < tokens.length; i++) {
    if (isPunct(tokens[i], ';')) {
      last = i;
      break;
    }
  }
  const slice = tokens.slice(first, last);
  const left = spot.left - first;
  const scopes = buildScopes(slice, slice.length, left);
  const analysis = new Analysis(
    slice,
    scopes,
    input.columnsOf,
    spot.typing >= 0 ? spot.typing - first : -1,
  );
  const scope = scopes.cursorScope;

  // `a.b.|`: a qualified name before the word being typed.
  const qualifiers: string[] = [];
  let j = left - 1;
  while (j >= 1 && isPunct(slice[j], '.') && isIdent(slice[j - 1])) {
    qualifiers.unshift(slice[j - 1]?.value ?? '');
    j -= 2;
  }
  if (j >= 0 && isPunct(slice[j], '.')) return done({ kind: 'none' });

  const ownBefore = scope.own.filter((index) => index <= j);
  const prevIndex = ownBefore.at(-1);
  const prev = prevIndex === undefined ? undefined : slice[prevIndex];
  const found = findClause(slice, scope, j);

  const relationsFor = (clause: FoundClause | null): ScopeRelation[] =>
    analysis.visibleFrom(
      scope,
      clause?.word === 'on' && clause.scope === scope ? clause.pos : null,
    );

  if (qualifiers.length > 0) {
    return done({
      kind: 'qualified',
      qualifiers,
      relations: relationsFor(found),
      clause: found?.word ?? null,
      position: 'expression',
      hasRelations: scope.decls.length > 0,
    });
  }
  // A type after `::` or in `CAST(x AS |)`; any other `AS` names something new.
  const castOpener = scope.opener >= 0 ? slice[scope.opener - 1] : undefined;
  if (isPunct(prev, '::') || (isWord(prev, 'as') && isWord(castOpener, 'cast'))) {
    return done({ kind: 'keywords', clause: 'type', position: 'operand' });
  }
  if (isWord(prev, 'as')) return done({ kind: 'none' });

  let clause = found;
  let nested = false;
  if (!clause && scope.opener >= 0) {
    nested = true;
    const before = slice[scope.opener - 1];
    if (isWord(before, 'values'))
      return done({ kind: 'keywords', clause: 'values', position: 'expression' });
    if (isWord(before, 'using')) {
      return done({
        kind: 'columns',
        clause: 'on',
        position: 'expression',
        relations: analysis.visibleFrom(scope, null),
        hasRelations: true,
      });
    }
    if (isIdent(before)) {
      // `INSERT INTO t (|)`: the column list of the target.
      const path: string[] = [];
      let k = scope.opener - 1;
      while (isIdent(slice[k])) {
        path.unshift(slice[k]?.value ?? '');
        if (!isPunct(slice[k - 1], '.')) {
          k -= 1;
          break;
        }
        k -= 2;
      }
      if (isWord(slice[k], 'into') && path.length > 0) {
        return done({
          kind: 'insertColumns',
          insertTarget: path,
          clause: 'into',
          position: 'expression',
        });
      }
    }
    if (isWord(before, 'from', 'join', 'as', 'union', 'intersect', 'except', 'lateral')) {
      return done({ kind: 'keywords', position: 'start' });
    }
    // A function call, `IN (…)`: an expression of the clause around.
    let bound = scope.opener - 1;
    for (let s = scope.parent; s && !clause; bound = s.opener - 1, s = s.parent) {
      clause = findClause(slice, s, bound);
    }
  }

  const word = clause?.word ?? null;
  const hasRelations = analysis.visibleFrom(scope, null).length > 0;
  const operand = ownBefore.length > 0 && afterOperand(prev, slice, prevIndex);

  if (word === null) {
    return done({
      kind: 'keywords',
      position: ownBefore.length === 0 && !nested ? 'start' : 'operand',
    });
  }
  if (RELATION_CLAUSES.has(word)) {
    if (nested) return done({ kind: 'keywords', clause: word, position: 'start' });
    const atKeyword = clause !== null && prevIndex === ownBefore[clause.pos];
    const afterComma = isPunct(prev, ',') && (word === 'from' || word === 'using');
    if (atKeyword || afterComma || isWord(prev, 'only', 'lateral')) {
      const wordBefore = clause ? slice[ownBefore[clause.pos - 1] ?? -1] : undefined;
      // `CREATE TABLE |` names something new.
      if (word === 'table' && isWord(wordBefore, 'create')) return done({ kind: 'none' });
      return done({
        kind: 'relation',
        clause: word,
        position: 'expression',
        relations: relationsFor(clause),
        hasRelations,
        ctes: analysis.visibleCtes(scope),
      });
    }
    return done({ kind: 'keywords', clause: word, position: 'operand', hasRelations });
  }
  if (word === 'exec' || word === 'execute' || word === 'call') {
    const atKeyword = clause !== null && prevIndex === ownBefore[clause.pos];
    return done({ kind: atKeyword ? 'routine' : 'keywords', clause: word, position: 'operand' });
  }
  if (KEYWORD_CLAUSES.has(word))
    return done({ kind: 'keywords', clause: word, position: 'operand' });
  if (STARTING_CLAUSES.has(word))
    return done({ kind: 'keywords', clause: word, position: 'start' });
  if (!EXPRESSION_CLAUSES.has(word))
    return done({ kind: 'keywords', clause: word, position: 'operand' });

  // An expression clause: columns, unless an operand was just written, when only the next
  // keyword fits.
  return done({
    kind: operand ? 'keywords' : 'columns',
    clause: word,
    position: operand ? 'operand' : 'expression',
    relations: relationsFor(clause),
    hasRelations,
  });
}

/** Whether `prev` ends an operand (a name, a literal, a closing parenthesis): no expression starts. */
function afterOperand(
  prev: Token | undefined,
  slice: Token[],
  prevIndex: number | undefined,
): boolean {
  if (!prev) return false;
  const before = prevIndex === undefined ? undefined : slice[prevIndex - 1];
  switch (prev.kind) {
    case 'word':
      return !EXPRESSION_KEYWORDS.has(prev.lower) && !CLAUSE_KEYWORDS.has(prev.lower);
    case 'number':
      // `SELECT TOP 10 |` still expects the select list.
      return !isWord(before, 'top');
    case 'quoted':
    case 'string':
    case 'param':
      return true;
    case 'punct':
      if (prev.value === ')') {
        // `TOP (5)` is not an operand: the select list follows.
        let depth = 0;
        for (let k = prevIndex ?? -1; k >= 0; k--) {
          const token = slice[k];
          if (isPunct(token, ')')) depth++;
          else if (isPunct(token, '(') && --depth === 0) return !isWord(slice[k - 1], 'top');
        }
        return true;
      }
      if (prev.value === '*') {
        return isWord(before, 'select', 'distinct') || isPunct(before, ',') || isPunct(before, '.');
      }
      return false;
    case 'comment':
      return false;
  }
}
