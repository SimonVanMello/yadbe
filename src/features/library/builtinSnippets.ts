import type { MessageKey } from '../../i18n/i18n';
import type { Engine } from '../../ipc';

/** A snippet that ships with yadbe: read-only, copied into the library to be customized. */
export interface BuiltinSnippet {
  /** Stable: `builtin:<trigger>` identifies it. */
  trigger: string;
  name: MessageKey;
  template: string;
}

interface Definition {
  trigger: string;
  name: MessageKey;
  /** The template of every engine without a specific one; `null`: the engine has no such thing. */
  template: string | null;
  engines?: Partial<Record<Engine, string | null>>;
}

const DEFINITIONS: readonly Definition[] = [
  {
    trigger: 'selt',
    name: 'library.builtin.selt',
    template: 'SELECT *\nFROM ${1:table}\nLIMIT ${2:100};',
    engines: { mssql: 'SELECT TOP (${2:100}) *\nFROM ${1:table};' },
  },
  {
    trigger: 'cnt',
    name: 'library.builtin.cnt',
    template:
      'SELECT ${1:column}, count(*) AS n\nFROM ${2:table}\nGROUP BY ${1:column}\nORDER BY n DESC;',
  },
  {
    trigger: 'dups',
    name: 'library.builtin.dups',
    template:
      'SELECT ${1:column}, count(*) AS n\nFROM ${2:table}\nGROUP BY ${1:column}\nHAVING count(*) > 1\nORDER BY n DESC;',
  },
  {
    trigger: 'ins',
    name: 'library.builtin.ins',
    template: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});',
  },
  {
    trigger: 'upd',
    name: 'library.builtin.upd',
    template: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};',
  },
  {
    trigger: 'del',
    name: 'library.builtin.del',
    template: 'DELETE FROM ${1:table}\nWHERE ${2:condition};',
  },
  {
    trigger: 'cte',
    name: 'library.builtin.cte',
    template: 'WITH ${1:name} AS (\n  ${2:SELECT 1}\n)\nSELECT *\nFROM ${1:name};',
  },
  {
    trigger: 'expl',
    name: 'library.builtin.expl',
    template: 'EXPLAIN ANALYZE\n${1:SELECT 1};',
    engines: {
      postgres: 'EXPLAIN (ANALYZE, BUFFERS)\n${1:SELECT 1};',
      sqlite: 'EXPLAIN QUERY PLAN\n${1:SELECT 1};',
      mssql: null,
    },
  },
];

/** The built-in snippets of an engine's dialect. */
export function builtinSnippetsFor(engine: Engine): BuiltinSnippet[] {
  const snippets: BuiltinSnippet[] = [];
  for (const definition of DEFINITIONS) {
    const specific = definition.engines?.[engine];
    const template = specific === undefined ? definition.template : specific;
    if (template !== null) {
      snippets.push({ trigger: definition.trigger, name: definition.name, template });
    }
  }
  return snippets;
}

/** The triggers the built-ins use, whatever the engine. */
export const BUILTIN_TRIGGERS: readonly string[] = DEFINITIONS.map(
  (definition) => definition.trigger,
);
