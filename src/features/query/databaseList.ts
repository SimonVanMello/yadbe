/**
 * SEAM for introspection (M1-1): the databases of a connection, for the toolbar's database
 * switcher. The contract has no `listDatabases` yet, so the list is unknown (`undefined`) and the
 * switcher only offers a field to type a database name. When the command lands, query it here
 * (TanStack Query, key `['databases', connectionId]`, `staleTime` of a few minutes) and return the
 * names: `DatabaseSwitcher` already shows them as a list above the field.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the seam keeps its final signature
export function useDatabaseList(_connectionId: string | null): string[] | undefined {
  return undefined;
}
