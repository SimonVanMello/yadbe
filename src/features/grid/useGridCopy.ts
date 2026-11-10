import { useCallback } from 'react';

import { showError } from '../../app/errors/presentError';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { toast, useToastStore } from '../../ui/toastStore';
import { writeClipboard } from './clipboard';
import { formatCopy, type CopyFormat, type CopyOptions } from './copyFormats';
import { gatherSelection, MAX_COPY_ROWS } from './copySelection';
import { formatCount } from './formatCount';
import type { RowSource } from './rowSource';
import type { Selection } from './selection';

/** A copy still reading after this long shows its progress (with Cancel). */
const PROGRESS_AFTER_MS = 300;

export type CopyExtras = Pick<CopyOptions, 'tableName' | 'quoteIdentifier'>;

/** Copies a selection to the clipboard in a format (F-063), reading rows as needed. */
export function useGridCopy(source: RowSource, extras?: CopyExtras) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  return useCallback(
    async (
      selection: Selection | null,
      order: readonly number[],
      format: CopyFormat,
      headers: boolean,
    ) => {
      if (!selection) return;
      const number = new Intl.NumberFormat(locale);
      const controller = new AbortController();
      const shown: { toast: number | null } = { toast: null };
      let progress = { done: 0, total: 0 };
      const progressTitle = () =>
        t('grid.copy.progress', {
          done: number.format(progress.done),
          total: number.format(progress.total),
        });
      const timer = setTimeout(() => {
        shown.toast = toast({
          title: progressTitle(),
          duration: Infinity,
          action: {
            label: t('common.cancel'),
            onClick: () => {
              controller.abort();
            },
          },
        });
      }, PROGRESS_AFTER_MS);
      try {
        const result = await gatherSelection(source, selection, order, {
          signal: controller.signal,
          onProgress: (done, total) => {
            progress = { done, total };
            if (shown.toast !== null) {
              useToastStore.getState().update(shown.toast, { title: progressTitle() });
            }
          },
        });
        const text = formatCopy(format, result.table, { headers, ...extras });
        await writeClipboard(text);
        const formatName = t(`grid.format.${format}`);
        if (result.copiedRows < result.selectedRows) {
          toast({
            variant: 'warning',
            title: t('grid.copy.limited', {
              copied: number.format(result.copiedRows),
              total: number.format(result.selectedRows),
            }),
            description: t('grid.copy.limited.hint', { limit: number.format(MAX_COPY_ROWS) }),
          });
        } else {
          toast({
            variant: 'success',
            title: formatCount(locale, 'grid.copy.done', result.copiedRows, {
              format: formatName,
            }),
            duration: 2000,
          });
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          showError(error, { title: t('grid.copy.failed') });
        }
      } finally {
        clearTimeout(timer);
        if (shown.toast !== null) useToastStore.getState().dismiss(shown.toast);
      }
    },
    [source, extras, t, locale],
  );
}
