import { useI18nStore, type MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ImportCommit, ImportOnError } from '../../ipc';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { Switch } from '../../ui/Switch';
import { formatBytes } from '../export/exportOptions';
import { ImportResult } from './ImportResult';
import { isLargeFile } from './importModel';
import styles from './ImportDialog.module.css';
import type { ImportWizard } from './useImportWizard';

const ON_ERROR: readonly ImportOnError[] = ['skip', 'stop'];
const COMMITS: readonly ImportCommit[] = ['single', 'perBatch'];

/** Step 3: how a bad row and a failure are handled, the dry run, and the import itself. */
export function RunStep({ wizard }: { wizard: ImportWizard }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const { job, running, preview, target } = wizard;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const labelled = <T extends string>(prefix: string, values: readonly T[]) =>
    values.map((value) => ({ value, label: t(`${prefix}.${value}` as MessageKey) }));
  const locked = running;

  return (
    <div className={styles.step}>
      <div className={styles.options}>
        <div className={styles.wide}>
          <SegmentedControl<ImportOnError>
            label={t('import.onError')}
            value={wizard.onError}
            options={labelled('import.onError', ON_ERROR)}
            onChange={wizard.setOnError}
          />
          <p className={styles.hint}>{t(`import.onError.${wizard.onError}Hint` as MessageKey)}</p>
        </div>
        <div className={styles.wide}>
          <SegmentedControl<ImportCommit>
            label={t('import.commit')}
            value={wizard.commit}
            options={labelled('import.commit', COMMITS)}
            onChange={wizard.setCommit}
          />
          <p className={styles.hint}>
            {wizard.commit === 'single'
              ? t('import.commit.singleHint')
              : t('import.commit.perBatchHint', { rows: number(target?.maxBatchRows ?? 1000) })}
          </p>
          {wizard.commit === 'single' && isLargeFile(preview?.fileSize ?? null) && (
            <p className={styles.warning} role="status">
              {t('import.commit.large', { size: formatBytes(preview?.fileSize ?? 0, locale) })}
            </p>
          )}
        </div>
        <div className={styles.switches}>
          <Switch
            label={t('import.saveRejects')}
            hint={t('import.saveRejectsHint')}
            checked={wizard.saveRejects}
            onCheckedChange={wizard.setSaveRejects}
            disabled={locked}
          />
          {wizard.prod && (
            <Switch
              label={t('import.prod.confirm', { name: wizard.connection?.name ?? '' })}
              checked={wizard.confirmedProd}
              onCheckedChange={wizard.setConfirmedProd}
              disabled={locked}
            />
          )}
        </div>
      </div>

      {running && job && (
        <div className={styles.progress} role="status" data-testid="import-progress">
          <Spinner />
          <span>
            {t(job.dryRun ? 'import.running.dry' : 'import.running', {
              rows: number(job.progress?.rowsRead ?? 0),
              inserted: number(job.progress?.inserted ?? 0),
              rejected: number(job.progress?.rejected ?? 0),
            })}
          </span>
          {job.progress && (job.progress.totalBytes ?? 0) > 0 && (
            <progress
              className={styles.bar}
              max={job.progress.totalBytes ?? 1}
              value={job.progress.bytesRead ?? 0}
              aria-label={t('import.progressLabel')}
            />
          )}
        </div>
      )}
      {job?.finished && <ImportResult finished={job.finished} />}
    </div>
  );
}
