import type {
  Engine,
  ExecuteScope,
  ParameterStyle,
  PlanFact,
  PlanNode,
  QueryParameter,
  QueryPlan,
  TextRange,
} from '../bindings';
import { mockSplit, mockStatementAt } from '../mockSplit';
import { sqlEntry, type SqlEngine } from '../sqlEngines';

/**
 * Query tools of the mock backend (F-048, F-053): the placeholders of a run, as the backend's
 * `db/params.rs` finds them, and canned plans shaped like each engine's.
 */

/** The statements a scope designates, like the backend's runner. */
export function mockScopeStatements(
  engine: Engine,
  text: string,
  scope: ExecuteScope,
): TextRange[] {
  if (scope.kind === 'all') return mockSplit(engine, text).map(({ from, to }) => ({ from, to }));
  if (scope.kind === 'range') {
    return mockSplit(engine, text.slice(scope.from, scope.to)).map((st) => ({
      from: st.from + scope.from,
      to: st.to + scope.from,
    }));
  }
  const found = mockStatementAt(engine, text, scope.offset);
  return found ? [{ from: found.from, to: found.to }] : [];
}

interface Styles {
  colon: boolean;
  at: boolean;
  atDeclared: boolean;
  dollarName: boolean;
  dollarNumber: boolean;
  question: boolean;
  questionNumber: boolean;
}

const STYLES: Record<SqlEngine, Styles> = {
  postgres: {
    colon: true,
    at: false,
    atDeclared: false,
    dollarName: false,
    dollarNumber: true,
    question: false,
    questionNumber: false,
  },
  mssql: {
    colon: false,
    at: true,
    atDeclared: true,
    dollarName: false,
    dollarNumber: false,
    question: false,
    questionNumber: false,
  },
  mysql: {
    colon: true,
    at: false,
    atDeclared: false,
    dollarName: false,
    dollarNumber: false,
    question: true,
    questionNumber: false,
  },
  sqlite: {
    colon: true,
    at: true,
    atDeclared: false,
    dollarName: true,
    dollarNumber: false,
    question: true,
    questionNumber: true,
  },
};

const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_$]/u;

interface Found {
  from: number;
  to: number;
  style: ParameterStyle;
  name: string;
}

/** Spans of the statement that are not code: strings, quoted names, comments, dollar bodies. */
function skip(engine: Engine, sql: string, i: number): number {
  const c = sql[i];
  const next = sql[i + 1];
  if (c === '-' && next === '-') {
    const end = sql.indexOf('\n', i);
    return end < 0 ? sql.length : end;
  }
  if (c === '#' && engine === 'mysql') {
    const end = sql.indexOf('\n', i);
    return end < 0 ? sql.length : end;
  }
  if (c === '/' && next === '*') {
    const end = sql.indexOf('*/', i + 2);
    return end < 0 ? sql.length : end + 2;
  }
  const close =
    c === "'" || c === '"'
      ? c
      : c === '`' && (engine === 'mysql' || engine === 'sqlite')
        ? '`'
        : c === '[' && (engine === 'mssql' || engine === 'sqlite')
          ? ']'
          : null;
  if (close !== null) {
    let j = i + 1;
    while (j < sql.length) {
      if (engine === 'mysql' && sql[j] === '\\') {
        j += 2;
        continue;
      }
      if (sql[j] === close) {
        if (sql[j + 1] === close) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return sql.length;
  }
  if (c === '$' && engine === 'postgres') {
    const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      return end < 0 ? sql.length : end + tag[0].length;
    }
  }
  return i;
}

function nameAt(sql: string, i: number): string {
  let j = i;
  while (j < sql.length && NAME_PART.test(sql[j] ?? '')) j++;
  return sql.slice(i, j);
}

/** The placeholders of one statement. */
export function mockPlaceholders(engine: Engine, sql: string): Found[] {
  const styles = sqlEntry(STYLES, engine);
  if (/^\s*(create|alter)\b[\s\S]{0,80}?\b(procedure|proc|function|trigger|event)\b/i.test(sql)) {
    return [];
  }
  const out: Found[] = [];
  const declared = new Set<string>();
  let brackets = 0;
  let i = 0;
  while (i < sql.length) {
    const skipped = skip(engine, sql, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = sql[i] ?? '';
    const prev = sql[i - 1];
    const next = sql[i + 1] ?? '';
    if (c === '[') brackets++;
    if (c === ']') brackets--;
    if (NAME_START.test(c) || /\d/.test(c)) {
      const word = nameAt(sql, i);
      if (styles.atDeclared && word.toLowerCase() === 'declare') {
        // The list runs until the next statement.
        const list =
          /^declare\b[\s\S]*?(?=;|\b(?:select|insert|update|delete|set|exec|execute|if|while|print)\b|$)/i.exec(
            sql.slice(i),
          )?.[0] ?? '';
        for (const match of list.matchAll(/(?:declare|,)\s*@(\w+)/gi)) {
          if (match[1]) declared.add(match[1].toLowerCase());
        }
      }
      i += Math.max(1, word.length);
      continue;
    }
    const doubled = prev === c || next === c;
    if (c === ':' && styles.colon && !doubled && brackets <= 0 && NAME_START.test(next)) {
      const name = nameAt(sql, i + 1);
      out.push({ from: i, to: i + 1 + name.length, style: 'colon', name });
      i += 1 + name.length;
      continue;
    }
    if (c === '@' && styles.at && !doubled && NAME_START.test(next)) {
      const name = nameAt(sql, i + 1);
      out.push({ from: i, to: i + 1 + name.length, style: 'at', name });
      i += 1 + name.length;
      continue;
    }
    if (c === '$' && /\d/.test(next) && styles.dollarNumber) {
      const digits = /^\d+/.exec(sql.slice(i + 1))?.[0] ?? '';
      out.push({
        from: i,
        to: i + 1 + digits.length,
        style: 'numbered',
        name: String(Number(digits)),
      });
      i += 1 + digits.length;
      continue;
    }
    if (c === '$' && styles.dollarName && NAME_START.test(next)) {
      const name = nameAt(sql, i + 1);
      out.push({ from: i, to: i + 1 + name.length, style: 'dollarName', name });
      i += 1 + name.length;
      continue;
    }
    if (c === '?' && styles.questionNumber && /\d/.test(next)) {
      const digits = /^\d+/.exec(sql.slice(i + 1))?.[0] ?? '';
      out.push({
        from: i,
        to: i + 1 + digits.length,
        style: 'numbered',
        name: String(Number(digits)),
      });
      i += 1 + digits.length;
      continue;
    }
    if (c === '?' && styles.question) {
      out.push({ from: i, to: i + 1, style: 'positional', name: '' });
    }
    i++;
  }
  return styles.atDeclared
    ? out.filter((p) => p.style !== 'at' || !declared.has(p.name.toLowerCase()))
    : out;
}

/** `query_parameters`: merged by name, in order of first appearance. */
export function mockQueryParameters(
  engine: Engine,
  text: string,
  scope: ExecuteScope,
): QueryParameter[] {
  const out: QueryParameter[] = [];
  let positional = 0;
  for (const statement of mockScopeStatements(engine, text, scope)) {
    const sql = text.slice(statement.from, statement.to);
    for (const found of mockPlaceholders(engine, sql)) {
      if (found.style === 'positional') positional++;
      const name = found.style === 'positional' ? `#${positional}` : found.name;
      const at = { from: statement.from + found.from, to: statement.from + found.to };
      const known = out.find((p) => p.name === name);
      if (known) known.occurrences.push(at);
      else
        out.push({
          name,
          label: sql.slice(found.from, found.to),
          style: found.style,
          occurrences: [at],
        });
    }
  }
  return out;
}

// --- Plans ----------------------------------------------------------------------------------

interface Draft {
  operation: string;
  relation?: string;
  index?: string;
  detail?: string;
  rows: number;
  cost: number;
  /** Own share of the time when analyzed, in ms. */
  ownMs: number;
  loops?: number;
  facts?: PlanFact[];
  children?: Draft[];
}

/** The tables a statement names after `FROM` / `JOIN`, for a plausible plan. */
function tablesOf(sql: string): string[] {
  const names = [...sql.matchAll(/\b(?:from|join)\s+([\w."[\]`]+)/gi)].map(
    (m) =>
      // The table's own name: `shop.orders` reads `orders` in the plan, as engines write it.
      (m[1] ?? '')
        .replace(/["[\]`]/g, '')
        .split('.')
        .pop() ?? '',
  );
  return names.length > 0 ? names : ['dual'];
}

function draftFor(engine: Engine, sql: string): Draft {
  const [first = 'orders', second] = tablesOf(sql);
  const words: Record<SqlEngine, { scan: string; seek: string; join: string; sort: string }> = {
    postgres: { scan: 'Seq Scan', seek: 'Index Scan', join: 'Hash Join', sort: 'Sort' },
    mssql: {
      scan: 'Clustered Index Scan',
      seek: 'Index Seek',
      join: 'Hash Match',
      sort: 'Sort',
    },
    mysql: { scan: 'Full table scan', seek: 'Index lookup', join: 'Nested loop', sort: 'Sort' },
    sqlite: {
      scan: `SCAN ${first}`,
      seek: `SEARCH ${second ?? first} USING INDEX ${second ?? first}_pkey (id=?)`,
      join: 'QUERY PLAN',
      sort: 'USE TEMP B-TREE FOR ORDER BY',
    },
  };
  const w = sqlEntry(words, engine);
  const scan: Draft = {
    operation: w.scan,
    relation: first,
    detail: engine === 'sqlite' ? undefined : "Filter: (status = 'open'::text)",
    rows: 48_210,
    cost: 1_843.2,
    ownMs: 41.7,
    facts: [{ label: 'Rows Removed by Filter', value: '151790' }],
  };
  if (!second) {
    return {
      operation: w.sort,
      detail: engine === 'sqlite' ? undefined : 'Sort Key: created_at DESC',
      rows: 48_210,
      cost: 5_210.9,
      ownMs: 12.3,
      children: [scan],
    };
  }
  const seek: Draft = {
    operation: w.seek,
    relation: second,
    index: `${second}_pkey`,
    detail: engine === 'sqlite' ? '(id=?)' : `Index Cond: (id = ${first}.${second}_id)`,
    rows: 1,
    cost: 0.42,
    ownMs: 3.1,
    loops: 48_210,
  };
  return {
    operation: w.sort,
    detail: engine === 'sqlite' ? undefined : 'Sort Key: total DESC',
    rows: 48_210,
    cost: 9_874.5,
    ownMs: 9.8,
    children: [
      {
        operation: w.join,
        detail:
          engine === 'sqlite' ? undefined : `Hash Cond: (${first}.${second}_id = ${second}.id)`,
        rows: 48_210,
        cost: 6_102.7,
        ownMs: 6.4,
        children: [scan, seek],
      },
    ],
  };
}

/** `explain_query`: a canned plan of the statement's tables, shaped like the engine's. */
export function mockPlan(engine: Engine, sql: string, analyzed: boolean): QueryPlan {
  const root = draftFor(engine, sql);
  const nodes: PlanNode[] = [];
  const total = { ms: 0 };
  const sum = (d: Draft): number =>
    d.ownMs + (d.children ?? []).reduce((acc, child) => acc + sum(child), 0);
  total.ms = sum(root);
  const costSelf = (d: Draft): number =>
    Math.max(0, d.cost - (d.children ?? []).reduce((acc, c) => acc + c.cost, 0));
  const totalCost = (function all(d: Draft): number {
    return costSelf(d) + (d.children ?? []).reduce((acc, c) => acc + all(c), 0);
  })(root);
  const walk = (d: Draft, parent: number | null, depth: number) => {
    const id = nodes.length;
    const heuristic = engine === 'sqlite';
    nodes.push({
      id,
      parent,
      depth,
      operation: d.operation,
      relation: d.relation ?? null,
      index: d.index ?? null,
      detail: d.detail ?? null,
      estimatedRows: heuristic ? null : d.rows,
      actualRows: analyzed ? Math.round(d.rows * 0.93) : null,
      loops: analyzed ? (d.loops ?? 1) : null,
      estimatedCost: heuristic ? null : d.cost,
      actualTimeMs: analyzed ? Math.round(sum(d) * 100) / 100 : null,
      weight: heuristic
        ? d.operation.startsWith('SCAN')
          ? 0.6
          : d.operation.startsWith('USE TEMP')
            ? 0.3
            : 0.1
        : analyzed
          ? d.ownMs / total.ms
          : costSelf(d) / totalCost,
      facts: d.facts ?? [],
    });
    for (const child of d.children ?? []) walk(child, id, depth + 1);
  };
  walk(root, null, 0);
  const summary: PlanFact[] =
    engine === 'sqlite'
      ? []
      : [
          { label: 'Total Cost', value: String(root.cost) },
          ...(analyzed
            ? [
                { label: 'Planning Time', value: '0.412 ms' },
                { label: 'Execution Time', value: `${(total.ms + 0.3).toFixed(3)} ms` },
              ]
            : []),
        ];
  const format = {
    postgres: 'postgresJson',
    mssql: 'showplanXml',
    mysql: analyzed ? 'mysqlTree' : 'mysqlJson',
    sqlite: 'sqliteRows',
  } as const;
  return {
    format: sqlEntry(format, engine),
    analyzed,
    weightBasis: engine === 'sqlite' ? 'heuristic' : analyzed ? 'time' : 'cost',
    nodes,
    summary,
    raw: JSON.stringify(
      nodes.map(({ operation, relation, estimatedRows }) => ({
        operation,
        relation,
        estimatedRows,
      })),
      null,
      2,
    ),
  };
}

/** What the backend sends to get a plan, per engine. */
export function mockExplainSent(engine: Engine, sql: string, analyzed: boolean): string {
  switch (engine) {
    case 'postgres':
      return `EXPLAIN (${analyzed ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) ${sql}`;
    case 'mssql':
      return analyzed
        ? `SET STATISTICS XML ON\n${sql}\nSET STATISTICS XML OFF`
        : `SET SHOWPLAN_XML ON\n${sql}\nSET SHOWPLAN_XML OFF`;
    case 'mysql':
      return analyzed ? `EXPLAIN ANALYZE ${sql}` : `EXPLAIN FORMAT=JSON ${sql}`;
    case 'sqlite':
    case 'redis':
    case 'mongodb':
    case 'elasticsearch':
      return `EXPLAIN QUERY PLAN ${sql}`;
  }
}
