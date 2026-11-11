import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import {
  ipc,
  unwrap,
  YadbeIpcError,
  type ImportAnalysis,
  type ImportCommit,
  type ImportConvertOptions,
  type ImportFinished,
  type ImportOnError,
  type ImportParseOptions,
  type ImportPreview,
  type ImportProgress,
  type ImportRequest,
  type ImportTarget,
  type YadbeError,
} from '../../ipc';
import { exportDialog } from '../../ipc/exportDialog';
import { importDialog } from '../../ipc/importDialog';
import { useYadbeEvent } from '../../ipc/useYadbeEvent';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { useConnection } from '../connections/connectionStore';
import {
  autoMatch,
  duplicatedFileColumns,
  mappedCount,
  missingRequired,
  rejectsName,
  rematch,
  toMapping,
  type ColumnPlan,
  type SourceChoice,
} from './importModel';
import type { ImportWizardRequest } from './importStore';

export type ImportStep = 'file' | 'columns' | 'run';

export const PREVIEW_ROWS = 8;

/** A started import: running, then its outcome. */
export interface ImportJob {
  /** `null` until the backend answered `startImport`. */
  importId: number | null;
  dryRun: boolean;
  progress: ImportProgress | null;
  finished: ImportFinished | null;
}

function errorOf(error: unknown): YadbeError | null {
  return error instanceof YadbeIpcError ? error.error : null;
}

function t(key: Parameters<typeof translate>[1]): string {
  return translate(useI18nStore.getState().locale, key);
}

/** All the state and the backend calls of the import wizard (F-091). */
export function useImportWizard(request: ImportWizardRequest) {
  const connection = useConnection(request.connectionId);
  const [step, setStep] = useState<ImportStep>('file');
  const [target, setTarget] = useState<ImportTarget | null>(null);
  const [targetError, setTargetError] = useState<YadbeError | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<YadbeError | null>(null);
  const [parse, setParse] = useState<ImportParseOptions | null>(null);
  const [convert, setConvert] = useState<ImportConvertOptions>({
    decimalSeparator: 'dot',
    binary: 'hex',
  });
  const [plans, setPlans] = useState<ColumnPlan[]>([]);
  const [checked, setChecked] = useState<{
    key: string;
    analysis: ImportAnalysis | null;
    error: YadbeError | null;
  } | null>(null);
  const [onError, setOnError] = useState<ImportOnError>('skip');
  const [commit, setCommit] = useState<ImportCommit>('single');
  const [saveRejects, setSaveRejects] = useState(false);
  const [confirmedProd, setConfirmedProd] = useState(false);
  const [job, setJob] = useState<ImportJob | null>(null);
  const jobRef = useRef<ImportJob | null>(null);
  /** Outcomes that arrived before `startImport` answered (a very short import). */
  const early = useRef(new Map<number, ImportFinished>());
  /** The file's columns the plans were last made from. */
  const columnsRef = useRef<string[]>([]);
  const previewSeq = useRef(0);
  const analysisSeq = useRef(0);

  const updateJob = useCallback((change: (job: ImportJob) => ImportJob) => {
    if (!jobRef.current) return;
    jobRef.current = change(jobRef.current);
    setJob(jobRef.current);
  }, []);

  useYadbeEvent('importProgress', (progress) => {
    if (progress.importId === jobRef.current?.importId) updateJob((j) => ({ ...j, progress }));
  });
  useYadbeEvent('importFinished', (finished) => {
    if (finished.importId === jobRef.current?.importId) {
      updateJob((j) => ({ ...j, finished }));
    } else {
      early.current.set(finished.importId, finished);
    }
  });

  // The columns the import can write, once.
  useEffect(() => {
    let current = true;
    unwrap(ipc.commands.getImportTarget(request.connectionId, request.table)).then(
      (found) => {
        if (current) setTarget(found);
      },
      (error: unknown) => {
        if (current) setTargetError(errorOf(error));
      },
    );
    return () => {
      current = false;
    };
  }, [request.connectionId, request.table]);

  const loadPreview = useCallback(
    async (file: string, options: ImportParseOptions | null) => {
      const seq = ++previewSeq.current;
      try {
        const loaded = await unwrap(ipc.commands.previewImportFile(file, options, PREVIEW_ROWS));
        if (seq !== previewSeq.current) return;
        setPreviewError(null);
        const before = columnsRef.current;
        columnsRef.current = loaded.columns;
        setPlans((current) => {
          if (!target) return current;
          return current.length > 0
            ? rematch(current, before, loaded.columns, target.columns)
            : autoMatch(loaded.columns, target.columns);
        });
        setPreview(loaded);
        setParse(loaded.options);
      } catch (error) {
        if (seq !== previewSeq.current) return;
        setPreviewError(errorOf(error));
        setPreview(null);
      }
    },
    [target],
  );

  const chooseFile = useCallback(async () => {
    const picked = await importDialog.pickDataFile({
      title: t('import.pick.title'),
      filterName: t('import.pick.filter'),
      allFiles: t('export.filter.all'),
    });
    if (picked === null) return;
    setPath(picked);
    setPreview(null);
    setPlans([]);
    columnsRef.current = [];
    setJob(null);
    jobRef.current = null;
    await loadPreview(picked, null);
  }, [loadPreview]);

  const changeParse = useCallback(
    (patch: Partial<ImportParseOptions>) => {
      if (!path || !parse) return;
      const next = { ...parse, ...patch };
      setParse(next);
      void loadPreview(path, next);
    },
    [path, parse, loadPreview],
  );

  const setChoice = useCallback((columnName: string, choice: SourceChoice) => {
    setPlans((current) =>
      current.map((plan) => (plan.column.name === columnName ? { ...plan, choice } : plan)),
    );
  }, []);

  const request_ = useMemo((): ImportRequest | null => {
    if (!path || !parse) return null;
    return {
      connectionId: request.connectionId,
      table: request.table,
      path,
      parse,
      mapping: toMapping(plans),
      convert,
      onError,
      commit,
      dryRun: false,
      rejectsPath: null,
    };
  }, [path, parse, plans, convert, onError, commit, request.connectionId, request.table]);

  // The type check follows the mapping, a moment after the last change.
  const checkKey = useDebouncedValue(
    request_ === null || request_.mapping.length === 0
      ? null
      : JSON.stringify([request_.path, request_.parse, request_.mapping, request_.convert]),
    300,
  );
  useEffect(() => {
    if (checkKey === null || step === 'file') return;
    const seq = ++analysisSeq.current;
    const [file, options, mapping, conversion] = JSON.parse(checkKey) as [
      string,
      ImportParseOptions,
      ImportRequest['mapping'],
      ImportConvertOptions,
    ];
    unwrap(
      ipc.commands.analyzeImport({
        connectionId: request.connectionId,
        table: request.table,
        path: file,
        parse: options,
        mapping,
        convert: conversion,
        onError: 'skip',
        commit: 'single',
        dryRun: false,
        rejectsPath: null,
      }),
    ).then(
      (result) => {
        if (seq === analysisSeq.current)
          setChecked({ key: checkKey, analysis: result, error: null });
      },
      (error: unknown) => {
        if (seq === analysisSeq.current) {
          setChecked({ key: checkKey, analysis: null, error: errorOf(error) });
        }
      },
    );
  }, [checkKey, step, request.connectionId, request.table]);
  // What was checked for another mapping is not shown for this one.
  const current = checkKey !== null && checked?.key === checkKey ? checked : null;
  const analysis = current?.analysis ?? null;
  const analysisError = current?.error ?? null;
  const analyzing = checkKey !== null && step !== 'file' && current === null;

  const start = useCallback(
    async (dryRun: boolean) => {
      if (!request_ || !path) return;
      let rejectsPath: string | null = null;
      if (saveRejects && !dryRun) {
        rejectsPath = await exportDialog.pickPath({
          title: t('import.rejects.saveTitle'),
          defaultName: rejectsName(path),
          filterName: t('export.filter.csv'),
          allFiles: t('export.filter.all'),
          extensions: ['csv'],
        });
        if (rejectsPath === null) return;
      }
      const next: ImportJob = { importId: null, dryRun, progress: null, finished: null };
      jobRef.current = next;
      setJob(next);
      try {
        const started = await unwrap(
          ipc.commands.startImport({ ...request_, dryRun, rejectsPath }),
        );
        const finished = early.current.get(started.importId) ?? null;
        early.current.delete(started.importId);
        updateJob((j) => ({ ...j, importId: started.importId, finished }));
      } catch (error) {
        jobRef.current = null;
        setJob(null);
        showError(error, { title: t('import.failed') });
      }
    },
    [request_, path, saveRejects, updateJob],
  );

  const cancel = useCallback(() => {
    const id = jobRef.current?.importId;
    if (id !== null && id !== undefined) void ipc.commands.cancelImport(id);
  }, []);

  const running = job !== null && job.finished === null;
  const missing = missingRequired(plans);
  const duplicated = duplicatedFileColumns(plans);
  const prod = connection?.environment === 'prod';

  return {
    connection,
    step,
    setStep,
    target,
    targetError,
    path,
    preview,
    previewError,
    parse,
    convert,
    setConvert,
    plans,
    analysis,
    analysisError,
    analyzing,
    onError,
    setOnError,
    commit,
    setCommit,
    saveRejects,
    setSaveRejects,
    confirmedProd,
    setConfirmedProd,
    job,
    running,
    missing,
    duplicated,
    mapped: mappedCount(plans),
    prod,
    chooseFile,
    changeParse,
    setChoice,
    start,
    cancel,
    /** A fresh run after an outcome: back to the options. */
    reset: () => {
      jobRef.current = null;
      setJob(null);
    },
  };
}

export type ImportWizard = ReturnType<typeof useImportWizard>;
