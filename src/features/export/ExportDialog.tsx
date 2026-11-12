import { useEffect, useId, useState } from 'react';

import { useI18nStore, type MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type ExportFormat, type ExportSourceSpec } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import { useConnection, useEngines } from '../connections/connectionStore';
import { engineInfoOf } from '../connections/model';
import {
  BINARY_ENCODINGS,
  CSV_DELIMITERS,
  CSV_QUOTES,
  DEFAULT_FORMAT_CONTEXT,
  EXPORT_FORMATS,
  JSON_LAYOUTS,
  JSON_NUMBERS,
  LINE_ENDINGS,
  MAX_ROWS_PER_STATEMENT,
  clampRows,
  exportScope,
  toExportFormat,
  type ExportFormatKind,
  type FormatContext,
} from './exportOptions';
import { useExportStore, type ExportDialogRequest } from './exportStore';
import { runExport } from './runExport';
import styles from './ExportDialog.module.css';

const PREVIEW_ROWS = 5;

type Preview = { kind: 'text'; text: string } | { kind: 'failed' };

/** Mounted once in the shell: opens on `useExportStore.open(...)`. */
export function ExportDialog() {
  const request = useExportStore((state) => state.request);
  const close = useExportStore((state) => state.close);
  return request && <ExportForm key={keyOf(request.source)} request={request} onClose={close} />;
}

function keyOf(source: ExportDialogRequest['source']): string {
  return source.kind === 'result' ? `result:${source.resultId}` : `table:${source.tabId}`;
}

function sourceSpec(
  source: ExportDialogRequest['source'],
  scope: ReturnType<typeof exportScope>,
): ExportSourceSpec {
  return source.kind === 'result'
    ? { kind: 'result', resultId: source.resultId, scope }
    : { kind: 'table', tabId: source.tabId, filter: source.filter, sort: source.sort };
}

function ExportForm({ request, onClose }: { request: ExportDialogRequest; onClose: () => void }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const connection = useConnection(request.connectionId ?? null);
  const id = useId();
  const prefs = useExportStore((state) => state.prefs);
  const setPrefs = useExportStore((state) => state.setPrefs);
  const { source } = request;
  const range = useExportStore((state) =>
    source.kind === 'result' ? (state.ranges[source.resultId] ?? null) : null,
  );
  const [selectionOnly, setSelectionOnly] = useState(range !== null);
  const { engines } = useEngines();
  // What a script and a workbook name: asked each time, starting from where the rows come from.
  const [schema, setSchema] = useState(request.target?.schema ?? '');
  const [table, setTable] = useState(request.target?.table ?? DEFAULT_FORMAT_CONTEXT.table);
  const [sheetName, setSheetName] = useState(
    request.label.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || DEFAULT_FORMAT_CONTEXT.sheetName,
  );
  const context: FormatContext = {
    engine: connection?.engine ?? DEFAULT_FORMAT_CONTEXT.engine,
    schema,
    table,
    sheetName,
  };
  const format = toExportFormat(prefs, context);
  const missingTable = prefs.format === 'sql' && table.trim() === '';
  const scope = exportScope(range, selectionOnly);

  const number = new Intl.NumberFormat(locale);
  const live =
    source.kind === 'result' && (source.status === 'streaming' || source.status === 'paused');
  const filtered =
    source.kind === 'table' &&
    (source.filter.conditions.length > 0 || (source.filter.rawWhere ?? '').trim() !== '');

  const setCsv = (patch: Partial<typeof prefs.csv>) => {
    setPrefs((current) => ({ ...current, csv: { ...current.csv, ...patch } }));
  };
  const setJson = (patch: Partial<typeof prefs.json>) => {
    setPrefs((current) => ({ ...current, json: { ...current.json, ...patch } }));
  };
  const setSql = (patch: Partial<typeof prefs.sql>) => {
    setPrefs((current) => ({ ...current, sql: { ...current.sql, ...patch } }));
  };
  const setMarkdown = (patch: Partial<typeof prefs.markdown>) => {
    setPrefs((current) => ({ ...current, markdown: { ...current.markdown, ...patch } }));
  };
  const setExcel = (patch: Partial<typeof prefs.excel>) => {
    setPrefs((current) => ({ ...current, excel: { ...current.excel, ...patch } }));
  };

  // The preview follows the options as they are typed, a moment later.
  const previewKey = JSON.stringify([format, sourceSpec(source, scope)]);
  const settled = useDebouncedValue(previewKey, 150);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    let current = true;
    const [settledFormat, settledSource] = JSON.parse(settled) as [ExportFormat, ExportSourceSpec];
    unwrap(ipc.commands.previewExport(settledSource, settledFormat, PREVIEW_ROWS)).then(
      (text) => {
        if (current) setPreview({ kind: 'text', text });
      },
      () => {
        if (current) setPreview({ kind: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [settled]);

  const start = () => {
    onClose();
    void runExport({ source: sourceSpec(source, scope), name: request.label, format });
  };

  const labelled = <T extends string>(prefix: string, values: readonly T[]) =>
    values.map((value) => ({ value, label: t(`${prefix}.${value}` as MessageKey) }));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      wide
      title={t(source.kind === 'table' ? 'export.table.title' : 'export.title')}
      description={t(source.kind === 'table' ? 'export.table.description' : 'export.description')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={start} disabled={missingTable}>
            {t('export.start')}
          </Button>
        </>
      }
    >
      {connection && <ConnectionBanner connection={connection} />}
      <div className={styles.form}>
        <div>
          <SegmentedControl<ExportFormatKind>
            label={t('export.format')}
            value={prefs.format}
            options={EXPORT_FORMATS.map((value) => ({
              value,
              label: t(`export.format.${value}`),
            }))}
            onChange={(value) => {
              setPrefs((current) => ({ ...current, format: value }));
            }}
          />
        </div>

        {range && (
          <Switch
            checked={selectionOnly}
            onCheckedChange={setSelectionOnly}
            label={t('export.selectionOnly')}
            hint={t('export.selectionHint', {
              rows: number.format(range.rowTo - range.rowFrom + 1),
              cols: number.format(range.columns.length),
            })}
          />
        )}
        {live && !selectionOnly && (
          <p className={styles.note} role="note">
            {source.status === 'paused'
              ? t('export.live.paused', { count: number.format(source.rowCount) })
              : t('export.live.streaming')}
          </p>
        )}
        {source.kind === 'result' && source.truncated && !live && !selectionOnly && (
          <p className={styles.note} role="note">
            {t('export.truncatedBefore', { count: number.format(source.rowCount) })}
          </p>
        )}
        {filtered && (
          <p className={styles.note} role="note">
            {t('export.table.filtered')}
          </p>
        )}
        {source.kind === 'table' && source.pending && (
          <p className={styles.note} role="note">
            {t('export.table.pending')}
          </p>
        )}

        {prefs.format === 'csv' && (
          <div className={styles.options}>
            <Field label={t('export.csv.delimiter')} htmlFor={`${id}-delimiter`}>
              <Select
                id={`${id}-delimiter`}
                value={prefs.csv.delimiter}
                options={labelled('export.csv.delimiter', CSV_DELIMITERS)}
                onChange={(delimiter) => {
                  setCsv({ delimiter });
                }}
              />
            </Field>
            <Field label={t('export.csv.quote')} htmlFor={`${id}-quote`}>
              <Select
                id={`${id}-quote`}
                value={prefs.csv.quote}
                options={labelled('export.csv.quote', CSV_QUOTES)}
                onChange={(quote) => {
                  setCsv({ quote });
                }}
              />
            </Field>
            <Field label={t('export.csv.lineEnding')} htmlFor={`${id}-eol`}>
              <Select
                id={`${id}-eol`}
                value={prefs.csv.lineEnding}
                options={labelled('export.csv.lineEnding', LINE_ENDINGS)}
                onChange={(lineEnding) => {
                  setCsv({ lineEnding });
                }}
              />
            </Field>
            <Field
              label={t('export.csv.nullText')}
              htmlFor={`${id}-null`}
              hint={t('export.csv.nullHint')}
            >
              <TextInput
                id={`${id}-null`}
                mono
                maxLength={32}
                value={prefs.csv.nullText}
                onChange={(event) => {
                  setCsv({ nullText: event.target.value });
                }}
              />
            </Field>
            <Field label={t('export.binary')} htmlFor={`${id}-binary`}>
              <Select
                id={`${id}-binary`}
                value={prefs.csv.binary}
                options={labelled('export.binary', BINARY_ENCODINGS)}
                onChange={(binary) => {
                  setCsv({ binary });
                }}
              />
            </Field>
            <div className={styles.switches}>
              <Switch
                checked={prefs.csv.header}
                onCheckedChange={(header) => {
                  setCsv({ header });
                }}
                label={t('export.csv.header')}
              />
              <Switch
                checked={prefs.csv.bom}
                onCheckedChange={(bom) => {
                  setCsv({ bom });
                }}
                label={t('export.csv.bom')}
                hint={t('export.csv.bomHint')}
              />
            </div>
          </div>
        )}
        {prefs.format === 'json' && (
          <div className={styles.options}>
            <Field label={t('export.json.layout')} htmlFor={`${id}-layout`}>
              <Select
                id={`${id}-layout`}
                value={prefs.json.layout}
                options={labelled('export.json.layout', JSON_LAYOUTS)}
                onChange={(layout) => {
                  setJson({ layout });
                }}
              />
            </Field>
            <Field
              label={t('export.json.numbers')}
              htmlFor={`${id}-numbers`}
              hint={t('export.json.numbersHint')}
            >
              <Select
                id={`${id}-numbers`}
                value={prefs.json.numbers}
                options={labelled('export.json.numbers', JSON_NUMBERS)}
                onChange={(numbers) => {
                  setJson({ numbers });
                }}
              />
            </Field>
            <Field label={t('export.binary')} htmlFor={`${id}-jbinary`}>
              <Select
                id={`${id}-jbinary`}
                value={prefs.json.binary}
                options={labelled('export.binary', BINARY_ENCODINGS)}
                onChange={(binary) => {
                  setJson({ binary });
                }}
              />
            </Field>
          </div>
        )}
        {prefs.format === 'sql' && (
          <div className={styles.options}>
            <Field
              label={t('export.sql.engine')}
              htmlFor={`${id}-engine`}
              hint={t('export.sql.engineHint')}
            >
              <Select
                id={`${id}-engine`}
                value={prefs.sql.engine ?? 'source'}
                options={[
                  {
                    value: 'source',
                    label: t('export.sql.engine.source', {
                      engine: engineInfoOf(engines, context.engine)?.label ?? context.engine,
                    }),
                  },
                  // A script is written for an engine of the SQL family: it needs a dialect.
                  ...engines
                    .filter((info) => info.capabilities.family === 'sql')
                    .map((info) => ({ value: info.engine, label: info.label })),
                ]}
                onChange={(value) => {
                  setSql({ engine: value === 'source' ? null : value });
                }}
              />
            </Field>
            <Field
              label={t('export.sql.schema')}
              htmlFor={`${id}-schema`}
              hint={t('export.sql.schemaHint')}
            >
              <TextInput
                id={`${id}-schema`}
                mono
                value={schema}
                onChange={(event) => {
                  setSchema(event.target.value);
                }}
              />
            </Field>
            <Field
              label={t('export.sql.table')}
              htmlFor={`${id}-table`}
              error={missingTable ? t('export.sql.tableRequired') : undefined}
            >
              <TextInput
                id={`${id}-table`}
                mono
                value={table}
                invalid={missingTable}
                onChange={(event) => {
                  setTable(event.target.value);
                }}
              />
            </Field>
            <Field
              label={t('export.sql.rows')}
              htmlFor={`${id}-rows`}
              hint={t('export.sql.rowsHint')}
            >
              <TextInput
                id={`${id}-rows`}
                type="number"
                min={1}
                max={MAX_ROWS_PER_STATEMENT}
                value={prefs.sql.rowsPerStatement}
                onChange={(event) => {
                  setSql({ rowsPerStatement: clampRows(event.target.valueAsNumber) });
                }}
              />
            </Field>
            <Field label={t('export.csv.lineEnding')} htmlFor={`${id}-sqleol`}>
              <Select
                id={`${id}-sqleol`}
                value={prefs.sql.lineEnding}
                options={labelled('export.csv.lineEnding', LINE_ENDINGS)}
                onChange={(lineEnding) => {
                  setSql({ lineEnding });
                }}
              />
            </Field>
          </div>
        )}
        {prefs.format === 'markdown' && (
          <div className={styles.options}>
            <Field label={t('export.md.nullText')} htmlFor={`${id}-mdnull`}>
              <TextInput
                id={`${id}-mdnull`}
                mono
                maxLength={32}
                value={prefs.markdown.nullText}
                onChange={(event) => {
                  setMarkdown({ nullText: event.target.value });
                }}
              />
            </Field>
            <Field label={t('export.csv.lineEnding')} htmlFor={`${id}-mdeol`}>
              <Select
                id={`${id}-mdeol`}
                value={prefs.markdown.lineEnding}
                options={labelled('export.csv.lineEnding', LINE_ENDINGS)}
                onChange={(lineEnding) => {
                  setMarkdown({ lineEnding });
                }}
              />
            </Field>
            <Field label={t('export.binary')} htmlFor={`${id}-mdbinary`}>
              <Select
                id={`${id}-mdbinary`}
                value={prefs.markdown.binary}
                options={labelled('export.binary', BINARY_ENCODINGS)}
                onChange={(binary) => {
                  setMarkdown({ binary });
                }}
              />
            </Field>
            <div className={styles.switches}>
              <Switch
                checked={prefs.markdown.alignNumbers}
                onCheckedChange={(alignNumbers) => {
                  setMarkdown({ alignNumbers });
                }}
                label={t('export.md.alignNumbers')}
              />
            </div>
          </div>
        )}
        {prefs.format === 'excel' && (
          <div className={styles.options}>
            <Field label={t('export.excel.sheet')} htmlFor={`${id}-sheet`}>
              <TextInput
                id={`${id}-sheet`}
                maxLength={31}
                value={sheetName}
                onChange={(event) => {
                  setSheetName(event.target.value);
                }}
              />
            </Field>
            <Field label={t('export.binary')} htmlFor={`${id}-xbinary`}>
              <Select
                id={`${id}-xbinary`}
                value={prefs.excel.binary}
                options={labelled('export.binary', BINARY_ENCODINGS)}
                onChange={(binary) => {
                  setExcel({ binary });
                }}
              />
            </Field>
            <p className={styles.note} role="note">
              {t('export.excel.hint')}
            </p>
          </div>
        )}

        <div className={styles.preview}>
          <div className={styles.previewTitle}>
            {prefs.format === 'excel'
              ? t('export.excel.preview')
              : t('export.preview', { count: PREVIEW_ROWS })}
          </div>
          <pre className={styles.previewText} aria-label={t('export.previewLabel')} tabIndex={0}>
            {preview?.kind === 'text' ? preview.text : ''}
            {preview?.kind === 'failed' && t('export.preview.failed')}
          </pre>
        </div>
      </div>
    </Dialog>
  );
}
