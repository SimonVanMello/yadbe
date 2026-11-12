import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, YadbeIpcError, type KvBytes, type YadbeError } from '../../ipc';
import { Button } from '../../ui/Button';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { formatBytes } from '../export/exportOptions';
import { JsonView } from '../grid/JsonView';
import { tryParseJson } from '../grid/jsonTree';
import styles from './KeyTab.module.css';
import { bytesId, bytesText, concatBytes, decodeBase64, hexDump, isUtf8 } from './kvBytes';

/** Bytes read per window of a string (the backend reads at most 1 MiB per call). */
export const STRING_WINDOW = 64 * 1024;
/** Largest value read whole to show as JSON. */
export const JSON_WHOLE_MAX = 4 * 1024 * 1024;
/** Largest value "load all" reads. */
const LOAD_ALL_MAX = 16 * 1024 * 1024;

type Mode = 'text' | 'json' | 'hex';

interface Loaded {
  chunks: Uint8Array[];
  total: number;
}

function sizeOf(loaded: Loaded): number {
  return loaded.chunks.reduce((n, chunk) => n + chunk.length, 0);
}

/** The mode a value opens in: JSON when it parses, text when it is UTF-8, else hex. */
export function initialMode(bytes: Uint8Array, complete: boolean): Mode {
  if (!isUtf8(bytes)) return 'hex';
  const text = bytesText(bytes).trimStart();
  if (complete && (text.startsWith('{') || text.startsWith('[')) && tryParseJson(text) !== null) {
    return 'json';
  }
  return 'text';
}

/**
 * A string value read by windows (large values are never read whole unless asked), shown as
 * text, pretty JSON or hex.
 */
export function StringViewer({
  connectionId,
  database,
  keyBytes,
}: {
  connectionId: string;
  database: number;
  keyBytes: KvBytes;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const [more, setMore] = useState<Loaded | null>(null);
  const [chosen, setChosen] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<YadbeError | null>(null);

  /** Reads `length` bytes after what `from` holds, a window per call. */
  const readAfter = async (from: Loaded | null, length: number): Promise<Loaded> => {
    const offset = from === null ? 0 : sizeOf(from);
    const chunks = [...(from?.chunks ?? [])];
    let total = from?.total ?? Infinity;
    let at = offset;
    while (at < Math.min(total, offset + length)) {
      const chunk = await unwrap(
        ipc.commands.kvReadString(
          connectionId,
          database,
          keyBytes,
          at,
          Math.min(1024 * 1024, offset + length - at),
        ),
      );
      total = chunk.total;
      const bytes = decodeBase64(chunk.base64);
      if (bytes.length === 0) break;
      chunks.push(bytes);
      at += bytes.length;
    }
    return { chunks, total: total === Infinity ? 0 : total };
  };

  // The first window; the tab remounts the viewer to read the key again.
  const first = useQuery({
    queryKey: ['kvString', connectionId, database, bytesId(keyBytes)],
    queryFn: () => readAfter(null, STRING_WINDOW),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const loaded = more ?? first.data ?? null;

  const read = (from: Loaded, length: number) => {
    setBusy(true);
    setError(null);
    readAfter(from, length)
      .then(setMore)
      .catch((caught: unknown) => {
        if (caught instanceof YadbeIpcError) setError(caught.error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const bytes = useMemo(() => (loaded ? concatBytes(loaded.chunks) : new Uint8Array()), [loaded]);
  const complete = loaded !== null && bytes.length >= loaded.total;
  const mode: Mode = chosen ?? (loaded ? initialMode(bytes, complete) : 'text');

  const choose = (next: Mode) => {
    setChosen(next);
    // JSON needs the whole value: read it when it is small enough.
    if (next === 'json' && loaded && !complete && !busy && loaded.total <= JSON_WHOLE_MAX) {
      read(loaded, loaded.total - bytes.length);
    }
  };

  const json = useMemo(
    () => (mode === 'json' && complete ? tryParseJson(bytesText(bytes)) : null),
    [mode, complete, bytes],
  );

  const failure = error ?? (first.error instanceof YadbeIpcError ? first.error.error : null);
  if (failure && !loaded) {
    return (
      <div className={styles.center}>
        <ErrorPanel title={t('keyValue.tab.readFailed')} error={failure} />
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }

  const left = loaded.total - bytes.length;
  return (
    <>
      <div className={styles.toolbar}>
        <SegmentedControl
          label={t('keyValue.string.mode')}
          value={mode}
          options={[
            { value: 'text', label: t('keyValue.string.text') },
            { value: 'json', label: t('keyValue.string.json') },
            { value: 'hex', label: t('keyValue.string.hex') },
          ]}
          onChange={choose}
        />
        <span className={styles.toolbarInfo}>
          {complete
            ? t('keyValue.string.size', { size: formatBytes(loaded.total, locale) })
            : t('keyValue.string.partial', {
                shown: formatBytes(bytes.length, locale),
                size: formatBytes(loaded.total, locale),
              })}
        </span>
        <span className={styles.spacer} />
        {busy && <Spinner />}
        {!complete && (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                read(loaded, STRING_WINDOW);
              }}
            >
              {t('keyValue.string.more', {
                size: formatBytes(Math.min(STRING_WINDOW, left), locale),
              })}
            </Button>
            {loaded.total <= LOAD_ALL_MAX && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  read(loaded, left);
                }}
              >
                {t('keyValue.string.all')}
              </Button>
            )}
          </>
        )}
      </div>
      {error && <ErrorPanel compact title={t('keyValue.tab.readFailed')} error={error} />}
      {mode === 'json' ? (
        json !== null ? (
          <div className={styles.json} data-testid="kv-json">
            <JsonView tree={json} openness="auto" />
          </div>
        ) : (
          <p className={styles.note}>
            {complete
              ? t('keyValue.string.notJson')
              : loaded.total > JSON_WHOLE_MAX
                ? t('keyValue.string.tooLargeForJson', {
                    size: formatBytes(JSON_WHOLE_MAX, locale),
                  })
                : t('keyValue.string.readingWhole')}
          </p>
        )
      ) : (
        <pre className={styles.content} data-mode={mode} data-testid="kv-string">
          {mode === 'hex' ? hexDump(bytes) : bytesText(bytes)}
        </pre>
      )}
    </>
  );
}
