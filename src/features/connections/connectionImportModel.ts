import type { FoundConnection } from '../../ipc';

/** Where a found connection goes, as one line: `host:port / database · user` or the file. */
export function describeTarget(found: FoundConnection): string {
  const d = found.definition;
  if (d.filePath) return d.filePath;
  const host = d.port === null ? d.host : `${d.host}:${String(d.port)}`;
  const where = d.database ? `${host} / ${d.database}` : host;
  return d.username ? `${where} · ${d.username}` : where;
}

/** The connections ticked by default: those that do not exist yet. */
export function defaultSelection(found: readonly FoundConnection[]): Set<string> {
  return new Set(found.filter((c) => c.conflict === null).map((c) => c.key));
}

/** The keys to import, in the order of the file. */
export function selectedKeys(
  found: readonly FoundConnection[],
  selected: ReadonlySet<string>,
): string[] {
  return found.filter((c) => selected.has(c.key)).map((c) => c.key);
}

/** Whether passwords can be imported: the source holds some among the ticked connections. */
export function passwordsAvailable(
  found: readonly FoundConnection[],
  selected: ReadonlySet<string>,
): boolean {
  return found.some((c) => c.hasPassword && selected.has(c.key));
}

export function folderLabel(path: readonly string[]): string {
  return path.join(' / ');
}
