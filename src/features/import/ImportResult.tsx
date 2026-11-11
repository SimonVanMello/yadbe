import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ImportFinished } from '../../ipc';
import { messageOfIssue } from './importModel';
import styles from './ImportDialog.module.css';

/** What an import (or its dry run) did, and the rows it did not write. */
export function ImportResult({ finished }: { finished: ImportFinished }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const { status, dryRun, commit } = finished;
  const tone =
    status === 'done' && finished.rejected === 0 ? 'good' : status === 'failed' ? 'bad' : 'warn';

  let headline: string;
  if (status === 'failed') headline = t('import.result.failed');
  else if (status === 'cancelled') {
    headline =
      commit === 'perBatch' && !dryRun && finished.kept > 0
        ? t('import.result.cancelled.batches', { count: finished.kept })
        : t('import.result.cancelled.rolledBack');
  } else if (dryRun) {
    headline = t('import.result.dry', {
      inserted: number(finished.inserted),
      rejected: number(finished.rejected),
    });
  } else {
    headline = t('import.result.done', {
      count: finished.inserted,
      formatted: number(finished.inserted),
    });
  }

  return (
    <div className={styles.result} data-tone={tone} data-testid="import-result" role="status">
      <p className={styles.resultHead}>{headline}</p>
      {finished.error && (
        <ErrorPanel title={t('import.result.failed')} error={finished.error} compact />
      )}
      <ul className={styles.facts}>
        <li>
          {t('import.result.read', {
            count: finished.rowsRead,
            formatted: number(finished.rowsRead),
          })}
        </li>
        {finished.rejected > 0 && (
          <li>
            {t('import.result.rejected', {
              count: finished.rejected,
              formatted: number(finished.rejected),
            })}
          </li>
        )}
        {status !== 'done' && !dryRun && commit === 'perBatch' && finished.kept > 0 && (
          <li>
            {t('import.result.kept', { count: finished.kept, formatted: number(finished.kept) })}
          </li>
        )}
        {status === 'failed' && commit === 'single' && !dryRun && (
          <li>{t('import.result.rolledBack')}</li>
        )}
        <li>
          {t('import.result.batches', { count: finished.batches })} ·{' '}
          {t('import.result.duration', {
            seconds: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
              (finished.durationMs ?? 0) / 1000,
            ),
          })}
        </li>
        {finished.droppedKeys > 0 && (
          <li>{t('import.result.droppedKeys', { count: finished.droppedKeys })}</li>
        )}
        {finished.invalidBytes > 0 && (
          <li>{t('import.warn.invalidBytes', { count: finished.invalidBytes })}</li>
        )}
        {finished.rejectsPath && (
          <li>{t('import.result.rejectsFile', { path: finished.rejectsPath })}</li>
        )}
      </ul>
      {finished.rejectSamples.length > 0 && (
        <div className={styles.rejects} role="region" aria-label={t('import.rejects.title')}>
          <table className={styles.previewTable}>
            <thead>
              <tr>
                <th scope="col">{t('import.rejects.line')}</th>
                <th scope="col">{t('import.rejects.column')}</th>
                <th scope="col">{t('import.rejects.value')}</th>
                <th scope="col">{t('import.rejects.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {finished.rejectSamples.slice(0, 20).map((reject) => (
                <tr key={`${String(reject.line)}:${reject.reason}`}>
                  <td>{reject.line}</td>
                  <td>{reject.column ?? '—'}</td>
                  <td>{reject.value ?? '—'}</td>
                  <td>
                    {t(messageOfIssue(reject.reason))}
                    {reject.detail ? ` — ${reject.detail}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {finished.rejected > Math.min(20, finished.rejectSamples.length) && (
            <p className={styles.muted}>
              {t('import.rejects.more', { count: Math.min(20, finished.rejectSamples.length) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
