import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  ipc,
  unwrap,
  type ExportFinished,
  type ExportFormat,
  type ExportProgress,
  type ExportScope,
} from '../../ipc';
import { exportDialog } from '../../ipc/exportDialog';
import { toast, useToastStore } from '../../ui/toastStore';
import { defaultFileName, dialogExtensions, formatBytes, withExtension } from './exportOptions';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(useI18nStore.getState().locale).format(value);
}

interface Job {
  toastId: number;
}

/** Exports running, by id. */
const jobs = new Map<number, Job>();
/** Events that came before `startExport` answered (a very short export). */
const early = new Map<number, ExportFinished>();

export interface ExportCommand {
  resultId: number;
  /** Base of the default file name. */
  name: string;
  format: ExportFormat;
  scope: ExportScope;
}

/** The file the dialog asks for, then the job: progress and the outcome arrive as toasts. */
export async function runExport(command: ExportCommand): Promise<void> {
  const picked = await exportDialog.pickPath({
    title: t('export.saveTitle'),
    defaultName: defaultFileName(command.name, command.format),
    filterName: t(command.format.format === 'csv' ? 'export.filter.csv' : 'export.filter.json'),
    allFiles: t('export.filter.all'),
    extensions: dialogExtensions(command.format),
  });
  if (picked === null) return;
  const path = withExtension(picked, command.format);
  const toastId = toast({
    title: t('export.progress', { rows: formatNumber(0), size: formatBytes(0, 'en') }),
    description: path,
    duration: Infinity,
    action: {
      label: t('common.cancel'),
      onClick: () => {
        for (const [exportId, job] of jobs) {
          if (job.toastId === toastId) void ipc.commands.cancelExport(exportId);
        }
      },
    },
  });
  try {
    const started = await unwrap(
      ipc.commands.startExport({
        source: { kind: 'result', resultId: command.resultId, scope: command.scope },
        format: command.format,
        path,
      }),
    );
    const finished = early.get(started.exportId);
    if (finished) {
      early.delete(started.exportId);
      showOutcome(finished, toastId);
    } else {
      jobs.set(started.exportId, { toastId });
    }
  } catch (error) {
    useToastStore.getState().dismiss(toastId);
    showError(error, { title: t('export.failed') });
  }
}

function onProgress(progress: ExportProgress): void {
  const job = jobs.get(progress.exportId);
  if (!job) return;
  useToastStore.getState().update(job.toastId, {
    title: t('export.progress', {
      rows: formatNumber(progress.rows),
      size: formatBytes(progress.bytes ?? 0, useI18nStore.getState().locale),
    }),
  });
}

function showOutcome(finished: ExportFinished, toastId: number): void {
  useToastStore.getState().dismiss(toastId);
  if (finished.status === 'done') {
    const size = formatBytes(finished.bytes ?? 0, useI18nStore.getState().locale);
    toast({
      variant: finished.truncated ? 'warning' : 'success',
      title: t(finished.rows === 1 ? 'export.done.one' : 'export.done', {
        count: finished.rows,
      }),
      description: [finished.path, size, finished.truncated ? t('export.truncated') : null]
        .filter(Boolean)
        .join(' · '),
      duration: 10_000,
    });
  } else if (finished.status === 'cancelled') {
    toast({ title: t('export.cancelled'), duration: 3000 });
  } else if (finished.error) {
    showError(finished.error, { title: t('export.failed') });
  }
}

function onFinished(finished: ExportFinished): void {
  const job = jobs.get(finished.exportId);
  if (!job) {
    early.set(finished.exportId, finished);
    return;
  }
  jobs.delete(finished.exportId);
  showOutcome(finished, job.toastId);
}

let started = false;

/** Listens to `export-progress` and `export-finished` for the life of the app. */
export function startExportFeed(): void {
  if (started) return;
  started = true;
  ipc.events.subscribe('exportProgress', onProgress);
  ipc.events.subscribe('exportFinished', onFinished);
}
