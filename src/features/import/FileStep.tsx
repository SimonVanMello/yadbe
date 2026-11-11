import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore, type MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ImportDelimiter, ImportEncoding, ImportFormat, ImportQuote } from '../../ipc';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { formatBytes } from '../export/exportOptions';
import { ImportPreviewTable } from './ImportPreviewTable';
import { fileNameOf } from './importModel';
import styles from './ImportDialog.module.css';
import type { ImportWizard } from './useImportWizard';

const FORMATS: readonly ImportFormat[] = ['csv', 'json', 'jsonLines'];
const ENCODINGS: readonly ImportEncoding[] = ['utf8', 'utf16le', 'utf16be', 'latin1'];
const DELIMITERS: readonly ImportDelimiter[] = ['comma', 'semicolon', 'tab', 'pipe'];
const QUOTES: readonly ImportQuote[] = ['double', 'single', 'none'];

/** Step 1: the file, how it is read, and what it looks like read that way. */
export function FileStep({ wizard }: { wizard: ImportWizard }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const { path, parse, preview, previewError, changeParse } = wizard;
  const labelled = <T extends string>(prefix: string, values: readonly T[]) =>
    values.map((value) => ({ value, label: t(`${prefix}.${value}` as MessageKey) }));

  return (
    <div className={styles.step}>
      <div className={styles.fileRow}>
        <div className={styles.fileName} data-testid="import-file">
          {path ? (
            <>
              <span className={styles.fileTitle}>{fileNameOf(path)}</span>
              <span className={styles.filePath}>{path}</span>
            </>
          ) : (
            <span className={styles.muted}>{t('import.file.none')}</span>
          )}
        </div>
        <Button
          variant={path ? 'secondary' : 'primary'}
          onClick={() => {
            void wizard.chooseFile();
          }}
        >
          {path ? t('import.file.change') : t('import.file.choose')}
        </Button>
      </div>

      {previewError && (
        <ErrorPanel title={t('import.error.preview')} error={previewError} compact />
      )}

      {parse && (
        <div className={styles.options}>
          <div className={styles.wide}>
            <SegmentedControl<ImportFormat>
              label={t('import.format')}
              value={parse.format}
              options={labelled('import.format', FORMATS)}
              onChange={(format) => {
                changeParse({ format });
              }}
            />
          </div>
          <Field label={t('import.encoding')} htmlFor="import-encoding">
            <Select<ImportEncoding>
              id="import-encoding"
              value={parse.encoding}
              options={labelled('import.encoding', ENCODINGS)}
              onChange={(encoding) => {
                changeParse({ encoding });
              }}
            />
          </Field>
          {parse.format === 'csv' && (
            <>
              <Field label={t('import.csv.delimiter')} htmlFor="import-delimiter">
                <Select<ImportDelimiter>
                  id="import-delimiter"
                  value={parse.delimiter}
                  options={labelled('import.csv.delimiter', DELIMITERS)}
                  onChange={(delimiter) => {
                    changeParse({ delimiter });
                  }}
                />
              </Field>
              <Field label={t('import.csv.quote')} htmlFor="import-quote">
                <Select<ImportQuote>
                  id="import-quote"
                  value={parse.quote}
                  options={labelled('import.csv.quote', QUOTES)}
                  onChange={(quote) => {
                    changeParse({ quote });
                  }}
                />
              </Field>
              <Field
                label={t('import.csv.nullToken')}
                htmlFor="import-null"
                hint={t('import.csv.nullTokenHint')}
              >
                <TextInput
                  id="import-null"
                  mono
                  value={parse.nullToken ?? ''}
                  placeholder="NULL"
                  onChange={(event) => {
                    changeParse({
                      nullToken: event.target.value === '' ? null : event.target.value,
                    });
                  }}
                />
              </Field>
              <Field label={t('import.csv.skipRows')} htmlFor="import-skip">
                <TextInput
                  id="import-skip"
                  type="number"
                  min={0}
                  value={parse.skipRows}
                  onChange={(event) => {
                    changeParse({ skipRows: Math.max(0, Math.floor(Number(event.target.value))) });
                  }}
                />
              </Field>
              <div className={styles.switches}>
                <Switch
                  label={t('import.csv.header')}
                  checked={parse.header}
                  onCheckedChange={(header) => {
                    changeParse({ header });
                  }}
                />
                <Switch
                  label={t('import.csv.emptyAsNull')}
                  hint={t('import.csv.emptyAsNullHint')}
                  checked={parse.emptyAsNull}
                  onCheckedChange={(emptyAsNull) => {
                    changeParse({ emptyAsNull });
                  }}
                />
                <Switch
                  label={t('import.csv.trim')}
                  checked={parse.trim}
                  onCheckedChange={(trim) => {
                    changeParse({ trim });
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {preview && (
        <div className={styles.previewSection}>
          <div className={styles.previewHead}>
            <span className={styles.sectionTitle}>
              {t('import.preview.title', { count: preview.rows.length })}
            </span>
            <span className={styles.muted}>
              {formatBytes(preview.fileSize ?? 0, locale)}
              {preview.bom ? ` · ${t('import.file.bom')}` : ''}
            </span>
          </div>
          <ImportPreviewTable preview={preview} />
          {preview.invalidBytes > 0 && (
            <p className={styles.warning} role="status">
              {t('import.warn.invalidBytes', { count: preview.invalidBytes })}
            </p>
          )}
          {preview.raggedRows > 0 && (
            <p className={styles.warning} role="status">
              {t('import.warn.ragged', { count: preview.raggedRows })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
