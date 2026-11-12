/** The name EF Core gives its history table (`db::ef::HISTORY_TABLE`). */
export const EF_HISTORY_TABLE = '__EFMigrationsHistory';

/** Case-insensitive: MySQL on a case-folding file system may store it in lower case. */
export function isEfHistoryTable(name: string): boolean {
  return name.toLowerCase() === EF_HISTORY_TABLE.toLowerCase();
}
