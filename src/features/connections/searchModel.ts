import type { ConnectionDefinition, SearchAuth, TlsMode } from '../../ipc';

/**
 * The search family's part of the connection form (Elasticsearch, OpenSearch): one URL, which
 * stands for the host, the port, TLS (its scheme) and the API's path, and how requests
 * authenticate. The secret (password, API key or token) is the draft's write-only password.
 */
export interface SearchDraft {
  /** As typed: `http://localhost:9200`, `https://search.example.com/es`. */
  url: string;
  auth: SearchAuth;
  /** HTTPS without checking the certificate (`require`), only on a trusted network. */
  skipVerify: boolean;
}

export const SEARCH_AUTHS: readonly SearchAuth[] = ['none', 'basic', 'apiKey', 'bearer'];

export function emptySearchDraft(): SearchDraft {
  return { url: 'http://localhost:9200', auth: 'basic', skipVerify: false };
}

/** What a URL says, credentials left out. */
export interface SearchUrl {
  https: boolean;
  host: string;
  /** The URL's port, or its scheme's (80 / 443). */
  port: number;
  pathPrefix: string | null;
  /** The URL holds a user or a password: the backend parses it (the password stays there). */
  credentials: boolean;
}

/** Reads a search URL; `null` when it is not an `http://` / `https://` URL with a host. */
export function parseSearchUrl(text: string): SearchUrl | null {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return null;
  const https = url.protocol === 'https:';
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  return {
    https,
    host,
    port: url.port === '' ? (https ? 443 : 80) : Number(url.port),
    pathPrefix: path === '' ? null : `/${decodeURIComponent(path)}`,
    credentials: url.username !== '' || url.password !== '',
  };
}

/** The URL of a saved connection, as the form shows it. */
export function searchUrlOf(
  definition: Pick<ConnectionDefinition, 'host' | 'port' | 'tlsMode' | 'search'>,
): string {
  const https = definition.tlsMode === 'require' || definition.tlsMode === 'verifyFull';
  const host = definition.host.includes(':') ? `[${definition.host}]` : definition.host;
  const port = definition.port ?? 9200;
  const defaultPort = https ? 443 : 80;
  return `${https ? 'https' : 'http'}://${host}${port === defaultPort ? '' : `:${String(port)}`}${
    definition.search?.pathPrefix ?? ''
  }`;
}

export function searchDraftFrom(definition: ConnectionDefinition): SearchDraft {
  if (!definition.search) return emptySearchDraft();
  return {
    url: searchUrlOf(definition),
    auth: definition.search.auth ?? 'basic',
    skipVerify: definition.tlsMode === 'require',
  };
}

/** The TLS mode a URL and the "skip verification" switch mean. */
export function searchTlsMode(https: boolean, skipVerify: boolean): TlsMode {
  if (!https) return 'disable';
  return skipVerify ? 'require' : 'verifyFull';
}

/** What a draft defines besides the common fields; `null` when the URL is not valid. */
export function searchDefinition(
  draft: SearchDraft,
): Pick<ConnectionDefinition, 'host' | 'port' | 'tlsMode' | 'search' | 'auth' | 'database'> | null {
  const url = parseSearchUrl(draft.url);
  if (!url) return null;
  return {
    host: url.host,
    port: url.port,
    tlsMode: searchTlsMode(url.https, draft.skipVerify),
    database: '',
    auth: draft.auth === 'none' ? 'none' : 'password',
    search: { auth: draft.auth, pathPrefix: url.pathPrefix },
  };
}
