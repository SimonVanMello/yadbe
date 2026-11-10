import { useCallback, useEffect, useRef, useState } from 'react';

import { AppearanceControls } from '../../app/AppearanceControls';
import { useHash } from '../../app/useHash';
import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import {
  ipc,
  isMock,
  unwrap,
  YadbeIpcError,
  type ExecutionDelta,
  type ResultSummary,
} from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { TextInput } from '../../ui/TextInput';
import { ResultGrid } from '../grid/ResultGrid';
import styles from './GridDemo.module.css';

const TAB_ID = 'grid-demo';
/** A connection of the mock whose password the mock keychain holds. */
const MOCK_CONNECTION = 'conn-local-pg';
const RETRIES = 100;
const RETRY_MS = 100;

const PRESETS = [
  { name: 'orders', sql: 'select * from orders' },
  { name: 'wide 100k × 50', sql: 'select * from big_table' },
  { name: 'huge 1M', sql: 'select * from huge' },
  { name: 'series', sql: 'select * from generate_series(1, 5000)' },
  { name: 'empty', sql: 'select * from orders where false' },
] as const;

interface Run {
  executionId: number | null;
  status: ExecutionDelta['status'] | 'starting' | 'error';
  results: ResultSummary[];
  error: string | null;
}

const IDLE: Run = { executionId: null, status: 'starting', results: [], error: null };

/** `#grid?sql=…&conn=…&tick=…` */
function params(hash: string): URLSearchParams {
  const at = hash.indexOf('?');
  return new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
}

function errorText(error: unknown): string {
  if (error instanceof YadbeIpcError) return localize(error.error.message);
  return error instanceof Error ? error.message : String(error);
}

/**
 * Development page (`#grid`): runs a query through the backend (the mock under `pnpm dev`, the
 * real one in the app) and mounts `ResultGrid` on its results. Used by the grid's Playwright
 * specs and the P-04 measurement.
 */
export function GridDemo() {
  const t = useT();
  const hash = useHash();
  const query = params(hash);
  const connectionId = query.get('conn') ?? MOCK_CONNECTION;
  const [sql, setSql] = useState(query.get('sql') ?? PRESETS[0].sql);
  const [run, setRun] = useState<Run>(IDLE);
  const [selected, setSelected] = useState<number | null>(null);
  const current = useRef<number | null>(null);
  const runSeq = useRef(0);
  const tick = query.get('tick');

  useEffect(() => {
    if (isMock && tick !== null) window.__yadbeMock?.setQueryTick(Number(tick));
  }, [tick]);

  useEffect(() => {
    const apply = (payload: { tabId: string; executionId: number; delta: ExecutionDelta }) => {
      if (payload.tabId !== TAB_ID || payload.executionId !== current.current) return;
      setRun((state) => {
        const results = [...state.results];
        for (const summary of payload.delta.results) {
          const index = results.findIndex((r) => r.resultId === summary.resultId);
          if (index >= 0) results[index] = summary;
          else results.push(summary);
        }
        const failure = payload.delta.messages.find((m) => m.body.kind === 'error');
        return {
          ...state,
          status: payload.delta.status,
          results,
          error:
            failure?.body.kind === 'error' ? localize(failure.body.error.message) : state.error,
        };
      });
    };
    const offProgress = ipc.events.subscribe('queryProgress', apply);
    const offFinished = ipc.events.subscribe('queryFinished', apply);
    return () => {
      offProgress();
      offFinished();
    };
  }, []);

  const execute = useCallback(
    async (text: string) => {
      const seq = ++runSeq.current;
      current.current = null;
      setRun(IDLE);
      setSelected(null);
      try {
        await unwrap(ipc.commands.cancelQuery(TAB_ID));
        await unwrap(ipc.commands.connect(connectionId, null));
        // The connection may still be opening, or the previous run stopping: retry a while.
        for (let attempt = 0; ; attempt++) {
          // A newer run started meanwhile (another click, or StrictMode's second effect).
          if (seq !== runSeq.current) return;
          const result = await ipc.commands.executeQuery({
            tabId: TAB_ID,
            connectionId,
            database: null,
            text,
            scope: { kind: 'all' },
            limits: null,
          });
          if (seq !== runSeq.current) {
            if (result.status === 'ok') await ipc.commands.cancelQuery(TAB_ID);
            return;
          }
          if (result.status === 'ok') {
            current.current = result.data.executionId;
            setRun((state) => ({ ...state, executionId: result.data.executionId }));
            return;
          }
          const busy = ['notConnected', 'executionRunning'].includes(result.error.code);
          if (!busy || attempt >= RETRIES) throw new YadbeIpcError(result.error);
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      } catch (error) {
        if (seq === runSeq.current) setRun({ ...IDLE, status: 'error', error: errorText(error) });
      }
    },
    [connectionId, setRun, setSelected],
  );

  const initialSql = useRef(sql);
  useEffect(() => {
    void execute(initialSql.current);
  }, [execute]);

  const shown = run.results.find((r) => r.resultId === selected) ?? run.results[0];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1 className={styles.title}>{t('demo.grid.title')}</h1>
          <p className={styles.subtitle}>{t('demo.grid.subtitle')}</p>
        </div>
        <div className={styles.settings}>
          <AppearanceControls />
          <a className={styles.back} href="#">
            {t('app.back')}
          </a>
        </div>
      </header>
      <form
        className={styles.toolbar}
        onSubmit={(event) => {
          event.preventDefault();
          void execute(sql);
        }}
      >
        <div className={styles.presets} role="group" aria-label={t('demo.grid.preset')}>
          {PRESETS.map((preset) => (
            <Button
              key={preset.name}
              size="sm"
              variant={preset.sql === sql ? 'secondary' : 'ghost'}
              onClick={() => {
                setSql(preset.sql);
                void execute(preset.sql);
              }}
            >
              {preset.name}
            </Button>
          ))}
        </div>
        <TextInput
          mono
          aria-label={t('demo.grid.sql')}
          className={styles.sql}
          value={sql}
          onChange={(event) => {
            setSql(event.target.value);
          }}
        />
        <Button type="submit" variant="primary" size="sm">
          <Icon name="play" />
          {t('demo.grid.run')}
        </Button>
        <span className={styles.status} data-testid="grid-demo-status">
          {run.status}
        </span>
      </form>
      {run.results.length > 1 && (
        <div className={styles.results}>
          {run.results.map((result) => (
            <Button
              key={result.resultId}
              size="sm"
              variant={result === shown ? 'secondary' : 'ghost'}
              onClick={() => {
                setSelected(result.resultId);
              }}
            >
              {t('grid.label', { number: result.statementIndex + 1 })}
            </Button>
          ))}
        </div>
      )}
      <main className={styles.content}>
        {run.error && (
          <p className={styles.error} role="alert">
            {t('demo.grid.failed')}: {run.error}
          </p>
        )}
        {shown ? (
          <ResultGrid resultId={shown.resultId} summary={shown} />
        ) : (
          !run.error && (
            <p className={styles.placeholder}>
              {run.status === 'starting' ? t('demo.grid.connecting') : t('demo.grid.noResult')}
            </p>
          )
        )}
      </main>
    </div>
  );
}
