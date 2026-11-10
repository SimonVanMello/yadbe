import type { Engine } from '../../ipc';
import { dialectOf } from '../query/sqlLanguage';

/**
 * The words the editor suggests besides the catalog's names: keywords and functions of the
 * engine's dialect, and its type names. Like `sqlLanguage`, this is the one place that knows
 * which words belong to which engine: the rest of the completion asks for a vocabulary.
 */

export type WordKind = 'keyword' | 'function' | 'type';

export interface Word {
  name: string;
  kind: WordKind;
}

export interface Vocabulary {
  keywords: readonly string[];
  functions: readonly string[];
  types: readonly string[];
}

const split = (words: string): string[] => words.split(/\s+/).filter(Boolean);

const COMMON_KEYWORDS = split(`
  select from where group by having order limit offset distinct all as and or not in is null like
  between exists case when then else end join inner left right full outer cross natural on using
  union intersect except insert into values update set delete create alter drop truncate table view
  index schema database with recursive asc desc nulls first last over partition rows range unbounded
  preceding following current row default primary key foreign references unique check constraint
  add column rename to if returning begin commit rollback transaction explain grant revoke true false
  any some fetch next only for cast interval lateral window
`);

const KEYWORDS: Record<Engine, string[]> = {
  postgres: split(`ilike similar analyze vacuum copy show describe materialized cascade restrict
    serial bigserial generated always identity do conflict nothing returning tablesample
    filter within group using extension sequence function procedure trigger type enum`),
  mssql: split(`top percent go exec execute declare print nolock output apply pivot unpivot
    identity merge matched try catch throw raiserror use proc procedure trigger nocount
    tran waitfor offset fetch`),
  mysql: split(`show describe explain use ignore replace duplicate straight_join auto_increment
    engine charset collate unsigned zerofill delimiter procedure function trigger databases tables
    status variables`),
  sqlite: split(`pragma vacuum attach detach analyze reindex replace glob autoincrement without
    rowid virtual temp temporary if exists indexed`),
};

const COMMON_FUNCTIONS = split(`
  count sum avg min max coalesce nullif greatest least abs round ceil ceiling floor power sqrt mod
  sign exp ln log upper lower trim ltrim rtrim length substring replace concat position left right
  row_number rank dense_rank ntile lag lead first_value last_value cast
`);

const FUNCTIONS: Record<Engine, string[]> = {
  postgres: split(`now current_timestamp current_date current_time date_trunc date_part extract age
    to_char to_date to_timestamp to_number string_agg array_agg jsonb_agg json_agg jsonb_build_object
    json_build_object jsonb_extract_path jsonb_array_elements unnest generate_series regexp_replace
    regexp_match split_part initcap lpad rpad char_length bool_and bool_or every random gen_random_uuid
    make_date make_interval nextval currval setval pg_typeof array_length cardinality`),
  mssql: split(`getdate getutcdate sysdatetime dateadd datediff datepart datename eomonth isnull
    iif len charindex patindex stuff string_agg string_split format convert try_convert try_cast
    newid scope_identity object_id isdate datefromparts concat_ws row_count json_value json_query
    openjson ascii char nchar reverse space str`),
  mysql: split(`now curdate curtime date_add date_sub date_format datediff timestampdiff str_to_date
    ifnull if concat_ws group_concat char_length locate instr lpad rpad find_in_set json_extract
    json_object json_arrayagg uuid last_insert_id found_rows rand truncate`),
  sqlite: split(`date time datetime julianday strftime ifnull iif instr substr printf random
    randomblob typeof total group_concat json json_extract json_group_array json_object
    last_insert_rowid changes unixepoch`),
};

const cache = new Map<Engine, Vocabulary>();

/** Keywords, functions and types of an engine's dialect (lower case, sorted, no duplicates). */
export function vocabularyOf(engine: Engine): Vocabulary {
  let found = cache.get(engine);
  if (!found) {
    const types = split(dialectOf(engine).spec.types ?? '');
    const sorted = (words: string[]) => [...new Set(words.map((w) => w.toLowerCase()))].sort();
    found = {
      keywords: sorted([...COMMON_KEYWORDS, ...KEYWORDS[engine]]),
      functions: sorted([...COMMON_FUNCTIONS, ...FUNCTIONS[engine]]),
      types: sorted(types),
    };
    cache.set(engine, found);
  }
  return found;
}

/** Keywords worth showing first, by what the statement is doing at the cursor. */
const STATEMENT_START = split(`select insert update delete with create alter drop truncate begin
  commit rollback explain grant revoke values merge show describe use pragma declare exec execute
  set copy vacuum analyze`);

const FROM_NEXT = split(`where join inner left right full cross natural on using group order
  having limit union intersect except as window offset fetch for`);

const OPERAND_NEXT = split(`from as and or not in is like ilike between asc desc group order having
  limit union intersect except offset then else end when over filter`);

const EXPRESSION_START = split(`case not distinct null true false exists interval cast any all
  some`);

/** Keywords boosted for a position (`start` / `operand` / `expression`) and clause, most useful first. */
export function boostedKeywords(
  position: string,
  clause: string | null,
): ReadonlyMap<string, number> {
  const ranked = (words: readonly string[]) => new Map(words.map((word, i) => [word, i] as const));
  if (position === 'start') return ranked(STATEMENT_START);
  if (position === 'expression') return ranked(EXPRESSION_START);
  switch (clause) {
    case 'from':
    case 'join':
    case 'using':
    case 'update':
      return ranked(FROM_NEXT);
    case 'into':
      return ranked(split('values select default'));
    case 'set':
      return ranked(split('where from returning'));
    case 'by':
      return ranked(split('asc desc nulls first last limit having offset union'));
    case 'insert':
      return ranked(['into']);
    case 'delete':
      return ranked(['from']);
    default:
      return ranked(OPERAND_NEXT);
  }
}
