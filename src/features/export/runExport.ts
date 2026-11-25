import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import {
  ipc,
  unwrap,
  type ExportFinished,
  type ExportFormat,
  type ExportProgress,
  type ExportSourceSpec,
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
  documents: boolean;
  total: number | null;
}

/** Exports running, by id. */
const jobs = new Map<number, Job>();
/** Events that came before `startExport` answered (a very short export). */
const early = new Map<number, ExportFinished>();

export interface ExportCommand {
  source: ExportSourceSpec;
  /** Base of the default file name. */
  name: string;
  format: ExportFormat;
  /** The rows the file will hold, when known exactly: the progress says "n of total". */
  total?: number | null;
}

/** What the save dialog is titled for a source. */
function saveTitle(source: ExportSourceSpec): MessageKey {
  switch (source.kind) {
    case 'table':
      return 'export.table.title';
    case 'collection':
      return 'export.collection.title';
    case 'index':
      return 'export.index.title';
    case 'result':
      return 'export.saveTitle';
  }
}

/** The progress line: rows or documents, out of the total when known. */
export function progressTitle(
  rows: number,
  size: string,
  documents: boolean,
  total: number | null,
): string {
  const params = { rows: formatNumber(rows), size };
  if (total === null) {
    return t(documents ? 'export.progress.documents' : 'export.progress', params);
  }
  return t(documents ? 'export.progress.documents.of' : 'export.progress.of', {
    ...params,
    total: formatNumber(total),
  });
}

/** The file the dialog asks for, then the job: progress and the outcome arrive as toasts. */
export async function runExport(command: ExportCommand): Promise<void> {
  const documents = command.source.kind === 'collection' || command.source.kind === 'index';
  const total = command.total ?? null;
  const picked = await exportDialog.pickPath({
    title: t(saveTitle(command.source)),
    defaultName: defaultFileName(command.name, command.format),
    filterName: t(`export.filter.${command.format.format}`),
    allFiles: t('export.filter.all'),
    extensions: dialogExtensions(command.format),
  });
  if (picked === null) return;
  const path = withExtension(picked, command.format);
  const toastId = toast({
    title: progressTitle(0, formatBytes(0, 'en'), documents, total),
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
        source: command.source,
        format: command.format,
        path,
      }),
    );
    const job = { toastId, documents, total };
    const finished = early.get(started.exportId);
    if (finished) {
      early.delete(started.exportId);
      showOutcome(finished, job);
    } else {
      jobs.set(started.exportId, job);
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
    title: progressTitle(
      progress.rows,
      formatBytes(progress.bytes ?? 0, useI18nStore.getState().locale),
      job.documents,
      job.total,
    ),
  });
}

function showOutcome(finished: ExportFinished, job: Job): void {
  useToastStore.getState().dismiss(job.toastId);
  if (finished.status === 'done') {
    const size = formatBytes(finished.bytes ?? 0, useI18nStore.getState().locale);
    toast({
      variant: finished.truncated || finished.limited ? 'warning' : 'success',
      title: t(job.documents ? 'export.done.documents' : 'export.done', {
        count: finished.rows,
      }),
      description: [
        finished.path,
        size,
        finished.truncated ? t('export.truncated') : null,
        finished.limited ? t('export.limited') : null,
      ]
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
  showOutcome(finished, job);
}

let started = false;

/** Listens to `export-progress` and `export-finished` for the life of the app. */
export function startExportFeed(): void {
  if (started) return;
  started = true;
  ipc.events.subscribe('exportProgress', onProgress);
  ipc.events.subscribe('exportFinished', onFinished);
}
