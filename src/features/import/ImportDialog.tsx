import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import { ColumnsStep } from './ColumnsStep';
import { FileStep } from './FileStep';
import { RunStep } from './RunStep';
import { tableLabel } from '../table-data/tableNames';
import { useImportStore, type ImportWizardRequest } from './importStore';
import styles from './ImportDialog.module.css';
import { useImportWizard, type ImportStep } from './useImportWizard';
import { ErrorPanel } from '../../app/errors/ErrorPanel';

const STEPS: readonly ImportStep[] = ['file', 'columns', 'run'];

/** Mounted once in the shell: opens on `openImport(...)`. */
export function ImportDialog() {
  const request = useImportStore((state) => state.request);
  const close = useImportStore((state) => state.close);
  return (
    request && (
      <ImportWizardView
        key={`${request.connectionId}:${request.table.schema ?? ''}.${request.table.name}`}
        request={request}
        onClose={close}
      />
    )
  );
}

/** The import wizard (F-091): file → columns → run, with a dry run before the real thing. */
function ImportWizardView({
  request,
  onClose,
}: {
  request: ImportWizardRequest;
  onClose: () => void;
}) {
  const t = useT();
  const wizard = useImportWizard(request);
  const { step, job, running, preview, missing } = wizard;
  const finishedReal = job?.finished?.status === 'done' && !job.dryRun;
  const stepIndex = STEPS.indexOf(step);

  const canLeaveFile = preview !== null && preview.columns.length > 0 && wizard.target !== null;
  const canLeaveColumns =
    wizard.mapped > 0 &&
    missing.length === 0 &&
    wizard.analysisError === null &&
    !wizard.target?.readOnly;
  const canRun =
    !running &&
    !finishedReal &&
    wizard.mapped > 0 &&
    missing.length === 0 &&
    !wizard.target?.readOnly &&
    (!wizard.prod || wizard.confirmedProd);

  const footer = (
    <>
      {running ? (
        <Button variant="danger" onClick={wizard.cancel}>
          {t('import.cancelImport')}
        </Button>
      ) : (
        <Button variant="ghost" onClick={onClose}>
          {finishedReal ? t('import.close') : t('common.cancel')}
        </Button>
      )}
      {stepIndex > 0 && !running && !finishedReal && (
        <Button
          onClick={() => {
            wizard.reset();
            wizard.setStep(STEPS[stepIndex - 1] ?? 'file');
          }}
        >
          {t('import.back')}
        </Button>
      )}
      {step === 'file' && (
        <Button
          variant="primary"
          disabled={!canLeaveFile}
          onClick={() => {
            wizard.setStep('columns');
          }}
        >
          {t('import.next')}
        </Button>
      )}
      {step === 'columns' && (
        <Button
          variant="primary"
          disabled={!canLeaveColumns}
          onClick={() => {
            wizard.setStep('run');
          }}
        >
          {t('import.next')}
        </Button>
      )}
      {step === 'run' && !finishedReal && (
        <>
          <Button
            disabled={!canRun}
            onClick={() => {
              void wizard.start(true);
            }}
          >
            {t('import.dryRun')}
          </Button>
          <Button
            variant="primary"
            disabled={!canRun}
            onClick={() => {
              void wizard.start(false);
            }}
          >
            {t('import.run')}
          </Button>
        </>
      )}
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
      wide
      title={t('import.title', { table: tableLabel(request.table) })}
      description={t('import.description')}
      footer={footer}
    >
      {wizard.connection && <ConnectionBanner connection={wizard.connection} />}
      <ol className={styles.steps} aria-label={t('import.steps')}>
        {STEPS.map((id, index) => (
          <li
            key={id}
            className={styles.stepItem}
            aria-current={id === step ? 'step' : undefined}
            data-done={index < stepIndex || undefined}
          >
            <span className={styles.stepNumber}>{index + 1}</span>
            {t(`import.step.${id}`)}
          </li>
        ))}
      </ol>
      {wizard.targetError && (
        <ErrorPanel title={t('import.error.target')} error={wizard.targetError} compact />
      )}
      {step === 'file' && <FileStep wizard={wizard} />}
      {step === 'columns' && <ColumnsStep wizard={wizard} />}
      {step === 'run' && <RunStep wizard={wizard} />}
    </Dialog>
  );
}
