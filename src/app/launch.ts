import { connectTo, openQuery } from '../features/connections/connectionActions';
import { connectionsApi } from '../features/connections/connectionsApi';
import { summarize, type EngineInfo } from '../features/connections/model';
import { openScriptPath } from '../features/query/queryActions';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../i18n/i18n';
import {
  ipc,
  unwrap,
  type LaunchRequest,
  type ParsedConnectionString,
  type SavedConnection,
} from '../ipc';
import { toast } from '../ui/toastStore';
import { useShellStore } from './shellStore';
import { selectActiveTab, useTabsStore } from './tabs/tabsStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * The saved connection a URL points at: same engine and, for what the URL states, same host,
 * port, database and user (a file engine: the same file). `null` when none matches.
 */
export function findSavedMatch(
  parsed: ParsedConnectionString,
  saved: readonly SavedConnection[],
  engines: readonly EngineInfo[],
): SavedConnection | null {
  const engine = parsed.engine;
  if (engine === null) return null;
  const defaultPort = engines.find((info) => info.engine === engine)?.capabilities.defaultPort;
  const same = (a: string | null | undefined, b: string | null) =>
    b === null || a?.toLowerCase() === b.toLowerCase();
  return (
    saved.find(({ definition }) => {
      if (definition.engine !== engine) return false;
      if (parsed.filePath !== null) return definition.filePath === parsed.filePath;
      if (parsed.host === null || !same(definition.host, parsed.host)) return false;
      const port = parsed.port ?? defaultPort ?? null;
      if (port !== null && (definition.port ?? defaultPort ?? null) !== port) return false;
      return (
        same(definition.database, parsed.database) && same(definition.username, parsed.username)
      );
    }) ?? null
  );
}

/** The connection a script opens on when the command line did not name one. */
function fallbackConnection(saved: readonly SavedConnection[]): SavedConnection | null {
  const active = selectActiveTab(useTabsStore.getState()).connectionId;
  const open = active === null ? undefined : saved.find((connection) => connection.id === active);
  if (open) return open;
  const recent = [...saved].sort(
    (a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0) || a.position - b.position,
  );
  return recent[0] ?? null;
}

/**
 * Carries out what the command line asked for (F-126): a connection URL opens the saved
 * connection it matches (its password comes from the keychain or is asked) or the connection
 * form filled in, never with a password; scripts open in query tabs bound to that connection,
 * else to the active tab's one, else the most recently used one. Nothing runs by itself.
 */
export async function applyLaunchRequests(requests: readonly LaunchRequest[]): Promise<void> {
  if (requests.length === 0) return;
  const [{ connections }, engines] = await Promise.all([
    connectionsApi.list(),
    connectionsApi.engines(),
  ]);
  let target: SavedConnection | null = null;

  for (const request of requests) {
    if (request.kind === 'rejected') {
      const key: MessageKey =
        request.reason === 'invalidUrl'
          ? 'launch.invalidUrl'
          : request.reason === 'fileNotFound'
            ? 'launch.fileNotFound'
            : 'launch.notAScript';
      toast({
        variant: 'error',
        title: t(key, { name: baseName(request.argument ?? '') }),
      });
    } else if (request.kind === 'connection') {
      const match = findSavedMatch(request.parsed, connections, engines);
      if (request.passwordIgnored)
        toast({ variant: 'warning', title: t('launch.passwordIgnored') });
      if (match) {
        target = match;
        openQuery(summarize(match), { newTab: true });
      } else {
        useShellStore
          .getState()
          .openConnectionDialog({ connectionId: null, parsed: request.parsed });
      }
    }
  }

  for (const request of requests) {
    if (request.kind !== 'sqlFile') continue;
    const connection = target ?? fallbackConnection(connections);
    if (!connection) {
      useShellStore.getState().openConnectionDialog({ connectionId: null });
      toast({
        variant: 'warning',
        title: t('launch.noConnection', { name: baseName(request.path) }),
      });
      continue;
    }
    target = connection;
    const opened = await openScriptPath(request.path, connection.id);
    if (opened) void connectTo(summarize(connection));
  }
}

/** Takes the command line's requests from the backend once, then carries them out. */
export async function handleLaunchRequests(): Promise<void> {
  try {
    const requests = await unwrap(ipc.commands.takeLaunchRequests());
    await applyLaunchRequests(requests);
  } catch (error) {
    console.warn('The command line was not applied', error);
  }
}
