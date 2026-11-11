import { ErrorPanel } from '../../app/errors/ErrorPanel';
import type { ErrorContext } from '../../app/errors/presentError';
import { useI18nStore } from '../../i18n/i18n';
import { formatDuration } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { TestConnectionResult, YadbeError } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { HopTrail } from './HopTrail';
import type { SshHopName } from './sshModel';
import styles from './TestResultView.module.css';

export type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; result: TestConnectionResult }
  | { status: 'error'; error: YadbeError };

interface TestResultViewProps {
  state: TestState;
  /** What the suggested actions of a failed test do in the form around it. */
  context: ErrorContext;
  /** SSH hops the test goes through, in order (none without a tunnel). */
  hops?: readonly SshHopName[];
}

/** Outcome of "Test connection" (F-004), under the form: success, or the typed error inline. */
export function TestResultView({ state, context, hops = [] }: TestResultViewProps) {
  const t = useT();
  const locale = useI18nStore((store) => store.locale);
  if (state.status === 'idle') return null;
  if (state.status === 'running') {
    return (
      <div className={styles.running} role="status">
        <Spinner />
        {t('connection.test.running')}
      </div>
    );
  }
  const route = hops.length > 0 ? [...hops, 'database' as const] : [];
  if (state.status === 'ok') {
    const { serverVersion, durationMs } = state.result;
    return (
      <div className={styles.ok} role="status">
        {route.length > 0 && <HopTrail hops={route} failed={null} />}
        <Icon name="check" size="md" />
        <span>
          {durationMs === null
            ? t('connection.test.okNoTime', { version: serverVersion })
            : t('connection.test.ok', {
                version: serverVersion,
                duration: formatDuration(durationMs, locale),
              })}
        </span>
      </div>
    );
  }
  return (
    <div className={styles.failed}>
      {route.length > 0 && (
        // A failure that names no hop happened at the database, the tunnel being up.
        <HopTrail hops={route} failed={state.error.tunnel?.hop ?? 'database'} />
      )}
      <ErrorPanel
        compact
        title={t('connection.test.failed')}
        error={state.error}
        context={context}
      />
    </div>
  );
}
