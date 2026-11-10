import { useEffect, useId, useState } from 'react';

import { useI18nStore, type MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type ExportFormat } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import {
  BINARY_ENCODINGS,
  CSV_DELIMITERS,
  CSV_QUOTES,
  JSON_LAYOUTS,
  JSON_NUMBERS,
  LINE_ENDINGS,
  exportScope,
  toExportFormat,
  type ExportFormatKind,
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
  return request && <ExportForm key={request.resultId} request={request} onClose={close} />;
}

function ExportForm({ request, onClose }: { request: ExportDialogRequest; onClose: () => void }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const id = useId();
  const prefs = useExportStore((state) => state.prefs);
  const setPrefs = useExportStore((state) => state.setPrefs);
  const range = useExportStore((state) => state.ranges[request.resultId] ?? null);
  const [selectionOnly, setSelectionOnly] = useState(range !== null);
  const format = toExportFormat(prefs);
  const scope = exportScope(range, selectionOnly);

  const number = new Intl.NumberFormat(locale);
  const live = request.status === 'streaming' || request.status === 'paused';

  const setCsv = (patch: Partial<typeof prefs.csv>) => {
    setPrefs((current) => ({ ...current, csv: { ...current.csv, ...patch } }));
  };
  const setJson = (patch: Partial<typeof prefs.json>) => {
    setPrefs((current) => ({ ...current, json: { ...current.json, ...patch } }));
  };

  // The preview follows the options as they are typed, a moment later.
  const previewKey = JSON.stringify([format, scope]);
  const settled = useDebouncedValue(previewKey, 150);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    let current = true;
    const [settledFormat, settledScope] = JSON.parse(settled) as [
      ExportFormat,
      ReturnType<typeof exportScope>,
    ];
    unwrap(
      ipc.commands.previewExport(
        { kind: 'result', resultId: request.resultId, scope: settledScope },
        settledFormat,
        PREVIEW_ROWS,
      ),
    ).then(
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
  }, [settled, request.resultId]);

  const start = () => {
    onClose();
    void runExport({
      resultId: request.resultId,
      name: request.label,
      format,
      scope,
    });
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
      title={t('export.title')}
      description={t('export.description')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={start}>
            {t('export.start')}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div>
          <SegmentedControl<ExportFormatKind>
            label={t('export.format')}
            value={prefs.format}
            options={[
              { value: 'csv', label: t('export.format.csv') },
              { value: 'json', label: t('export.format.json') },
            ]}
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
            {request.status === 'paused'
              ? t('export.live.paused', { count: number.format(request.rowCount) })
              : t('export.live.streaming')}
          </p>
        )}

        {prefs.format === 'csv' ? (
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
        ) : (
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

        <div className={styles.preview}>
          <div className={styles.previewTitle}>{t('export.preview', { count: PREVIEW_ROWS })}</div>
          <pre className={styles.previewText} aria-label={t('export.previewLabel')} tabIndex={0}>
            {preview?.kind === 'text' ? preview.text : ''}
            {preview?.kind === 'failed' && t('export.preview.failed')}
          </pre>
        </div>
      </div>
    </Dialog>
  );
}
