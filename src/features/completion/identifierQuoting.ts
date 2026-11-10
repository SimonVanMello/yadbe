import type { Capabilities } from '../../ipc';
import type { QuoteRules } from './sqlTokens';

/** What the dialect says about writing a name: from the engine's capabilities, never its name. */
export interface Quoting extends QuoteRules {
  /** Unquoted names are read in lower case, so a name with capitals must be quoted. */
  foldsToLower: boolean;
}

export function quotingOf(capabilities: Capabilities): Quoting {
  return {
    open: capabilities.identifierQuoteOpen,
    close: capabilities.identifierQuoteClose,
    foldsToLower: capabilities.foldsUnquotedToLower,
  };
}

/** Quoting used until the engine's capabilities are known: the standard double quote. */
export const STANDARD_QUOTING: Quoting = { open: '"', close: '"', foldsToLower: false };

/**
 * Words reserved by at least one of the engines. A name that spells one is quoted on insert on
 * every engine: a quote too many is harmless, a missing one is a syntax error.
 */
const RESERVED = new Set(
  (
    'add all alter and any as asc authorization backup begin between break by case cast check ' +
    'collate column commit constraint create cross current current_date current_time ' +
    'current_timestamp current_user cursor database declare default delete desc distinct drop ' +
    'else end escape except exec execute exists external fetch for foreign from full function ' +
    'grant group having identity if in index inner insert intersect into is join key left like ' +
    'limit natural not null of offset on only open or order outer over partition percent ' +
    'primary procedure public references return returning revoke right rollback row rows ' +
    'schema select session_user set some table then to top transaction trigger truncate union ' +
    'unique update user using values view when where while window with'
  ).split(' '),
);

const PLAIN = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

export function needsQuotes(name: string, quoting: Quoting): boolean {
  if (!PLAIN.test(name)) return true;
  if (RESERVED.has(name.toLowerCase())) return true;
  return quoting.foldsToLower && name !== name.toLowerCase();
}

/** The name as it is written in SQL: quoted when it has to be, as is otherwise. */
export function quoteIfNeeded(name: string, quoting: Quoting): string {
  return needsQuotes(name, quoting) ? quote(name, quoting) : name;
}

/** The name quoted, with the closing quote doubled inside. */
export function quote(name: string, quoting: Quoting): string {
  const escaped = name.split(quoting.close).join(quoting.close + quoting.close);
  return `${quoting.open}${escaped}${quoting.close}`;
}
