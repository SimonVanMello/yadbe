import { showError } from '../../app/errors/presentError';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import type { DdlTarget, ObjectKind, ObjectRef } from '../../ipc';
import { toast } from '../../ui/toastStore';
import { openQueryTab } from '../query/openQueryTab';
import { ddlTargetObject } from './objectsModel';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Opens an object's definition in a read-only tab (F-024). Returns the tab's id. */
export function showDdl(connectionId: string, target: DdlTarget): string {
  return useTabsStore.getState().openDdlTab(connectionId, target);
}

/** The definition of a table, view, routine, sequence or type of the explorer. */
export function showObjectDdl(
  connectionId: string,
  object: ObjectRef,
  kind: ObjectKind,
  id: string = object.name,
): string {
  return showDdl(connectionId, { type: 'object', object, kind, id });
}

/** "Open in a query tab": the text, editable, in a new tab on the object's database. */
export function openDdlInQuery(connectionId: string, target: DdlTarget, sql: string): void {
  openQueryTab({
    connectionId,
    database: ddlTargetObject(target).database,
    initialText: sql,
    reuseWelcomeTab: false,
  });
}

export async function copyDdl(sql: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sql);
    toast({ variant: 'success', title: t('objects.ddl.copied') });
  } catch (error) {
    showError(error, { title: t('objects.ddl.copyFailed') });
  }
}
