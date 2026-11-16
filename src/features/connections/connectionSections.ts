import type { MessageKey, MessageParams } from '../../i18n/i18n';
import {
  defaultTlsMode,
  parseSeconds,
  type ConnectionDraft,
  type EngineInfo,
  type TlsMode,
} from './model';
import { parseSearchUrl } from './searchModel';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** What the header of a closed section of the connection form says about it. */
export interface SectionSummary {
  /** One line: the values that differ from the defaults, else what the defaults are. */
  text: string;
  /** Something in the section differs from what a new connection starts with. */
  modified: boolean;
}

/** The `data-field` names of each closed-by-default section, to open it on demand. */
export const TLS_FIELDS = ['tls', 'tls-cert', 'tls-key', 'tls-passphrase', 'caCertPath'] as const;
export const ADVANCED_FIELDS = [
  'srv',
  'replicaSet',
  'authMechanism',
  'authSource',
  'directConnection',
  'keyDelimiter',
  'connectTimeout',
  'statementTimeout',
  'keepAlive',
] as const;
export const ENVIRONMENT_FIELDS = ['environmentLabel'] as const;

const SEPARATOR = ' · ';

/** MongoDB and Redis have no opportunistic TLS: `prefer` (a local host's default) is none. */
export function shownTlsMode(tlsMode: TlsMode, info: EngineInfo): TlsMode {
  const { family } = info.capabilities;
  return (family === 'document' || family === 'keyValue') && tlsMode === 'prefer'
    ? 'disable'
    : tlsMode;
}

/** Whether the form has a TLS section: server engines, and a search URL in `https://`. */
export function hasTlsSection(draft: ConnectionDraft, info: EngineInfo): boolean {
  const { capabilities } = info;
  if (capabilities.usesFile) return false;
  switch (capabilities.family) {
    case 'search':
      return parseSearchUrl(draft.search.url)?.https ?? false;
    case 'document':
    case 'keyValue':
      return true;
    default:
      return capabilities.supportsTls || capabilities.clientCertificate;
  }
}

/** TLS: the mode (or the certificate check of a search URL), a CA file, a client certificate. */
export function tlsSummary(draft: ConnectionDraft, info: EngineInfo, t: Translate): SectionSummary {
  const { capabilities } = info;
  const parts: string[] = [];
  let modified: boolean;
  let encrypted: boolean;
  if (capabilities.family === 'search') {
    parts.push(
      draft.search.skipVerify ? t('connection.section.noVerify') : t('connection.tls.verifyFull'),
    );
    modified = draft.search.skipVerify;
    encrypted = true;
    if (draft.caCertPath !== null && draft.caCertPath.trim() !== '') {
      parts.push(t('connection.section.caFile'));
      modified = true;
    }
  } else {
    const mode = shownTlsMode(draft.tlsMode, info);
    parts.push(t(`connection.tls.${mode}`));
    modified = mode !== shownTlsMode(defaultTlsMode(draft.host), info);
    encrypted = mode !== 'disable';
  }
  if (capabilities.clientCertificate && encrypted && draft.tlsClientCert.trim() !== '') {
    parts.push(t('connection.section.clientCert'));
    modified = true;
  }
  return { text: parts.join(SEPARATOR), modified };
}

/** Environment, read-only and history: the environment's name and the switches turned. */
export function environmentSummary(
  draft: ConnectionDraft,
  t: Translate,
): SectionSummary & { details: string[] } {
  const details: string[] = [];
  if (draft.readOnly) details.push(t('connection.section.readOnly'));
  if (!draft.historyEnabled) details.push(t('connection.section.noHistory'));
  const environment =
    draft.environment === 'none'
      ? null
      : draft.environment === 'custom'
        ? draft.environmentLabel.trim() || t('environment.custom')
        : t(`environment.${draft.environment}`);
  const parts = environment === null ? details : [environment, ...details];
  return {
    text: parts.length > 0 ? parts.join(SEPARATOR) : t('connection.section.noEnvironment'),
    modified: parts.length > 0,
    details,
  };
}

/** Advanced options: the family's own settings and the timeouts that were set. */
export function advancedSummary(
  draft: ConnectionDraft,
  info: EngineInfo,
  t: Translate,
): SectionSummary {
  const { capabilities } = info;
  const parts: string[] = [];
  if (capabilities.family === 'document') {
    const { mongo } = draft;
    if (mongo.srv) parts.push(t('connection.section.srv'));
    const replicaSet = mongo.replicaSet.trim();
    if (replicaSet !== '') parts.push(t('connection.section.replicaSet', { name: replicaSet }));
    if (mongo.directConnection && !mongo.srv) parts.push(t('connection.section.direct'));
    if (mongo.authMechanism !== 'default') parts.push(t(`mongo.mechanism.${mongo.authMechanism}`));
    const authSource = mongo.authSource.trim();
    if (mongo.authMechanism !== 'x509' && authSource !== '') {
      parts.push(t('connection.section.authSource', { name: authSource }));
    }
  }
  if (capabilities.family === 'keyValue' && draft.keyDelimiter !== '') {
    parts.push(t('connection.section.delimiter', { delimiter: draft.keyDelimiter }));
  }
  const file = capabilities.usesFile;
  const connect = parseSeconds(draft.connectTimeout);
  if (!file && connect !== null) {
    parts.push(t('connection.section.connectTimeout', { seconds: connect }));
  }
  const statement = parseSeconds(draft.statementTimeout);
  // 0 is "no limit", the default.
  if (statement !== null && statement > 0) {
    parts.push(t('connection.section.statementTimeout', { seconds: statement }));
  }
  const keepAlive = parseSeconds(draft.keepAlive);
  if (!file && keepAlive !== null) {
    parts.push(t('connection.section.keepAlive', { seconds: keepAlive }));
  }
  return {
    text: parts.length > 0 ? parts.join(SEPARATOR) : t('connection.section.defaults'),
    modified: parts.length > 0,
  };
}
