import { useT } from '../../i18n/useT';
import type { ImportPreview } from '../../ipc';
import styles from './ImportDialog.module.css';

/** The first rows of the file as the options read them; `NULL` is shown, not an empty cell. */
export function ImportPreviewTable({ preview }: { preview: ImportPreview }) {
  const t = useT();
  if (preview.columns.length === 0) {
    return <p className={styles.muted}>{t('import.preview.empty')}</p>;
  }
  return (
    <div className={styles.previewWrap} role="region" aria-label={t('import.preview.title')}>
      <table className={styles.previewTable}>
        <thead>
          <tr>
            {preview.columns.map((name, index) => (
              <th key={`${String(index)}:${name}`} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {preview.columns.map((_, index) => {
                const cell = row[index];
                return (
                  <td key={index} data-null={cell === null || cell === undefined || undefined}>
                    {cell === null || cell === undefined ? t('import.preview.null') : cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.rows.length === 0 && <p className={styles.muted}>{t('import.preview.empty')}</p>}
    </div>
  );
}
