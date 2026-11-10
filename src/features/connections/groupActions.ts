import { confirm } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { queryClient } from '../../app/queryClient';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { connectionsApi } from './connectionsApi';
import { connectionKeys, refreshConnections } from './connectionStore';
import type { ConnectionGroup } from './model';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Renames `group`, or creates a folder under `parentId`. Returns whether it worked. */
export async function saveGroup(
  name: string,
  target: { group?: ConnectionGroup; parentId?: string | null },
): Promise<boolean> {
  try {
    if (target.group) await connectionsApi.renameGroup(target.group.id, name);
    else await connectionsApi.createGroup(name, target.parentId ?? null);
  } catch (error) {
    showError(error, { title: t('group.saveFailed') });
    return false;
  }
  await refreshConnections();
  return true;
}

/** Deletes a folder after confirming; its connections and subgroups move up one level. */
export async function deleteGroup(group: ConnectionGroup, count: number): Promise<boolean> {
  const confirmed = await confirm({
    title: t('group.delete.title', { name: group.name }),
    description: t('group.delete.description'),
    confirmLabel: t('group.delete.confirm'),
    danger: true,
    items: [
      { label: group.name, note: t('group.delete.removed'), danger: true },
      ...(count > 0
        ? [{ label: t('group.delete.connections', { count }), note: t('group.delete.kept') }]
        : []),
    ],
  });
  if (!confirmed) return false;
  try {
    await connectionsApi.deleteGroup(group.id);
  } catch (error) {
    showError(error, { title: t('group.deleteFailed', { name: group.name }) });
    return false;
  }
  await refreshConnections();
  return true;
}

/** Folds or unfolds a folder; the backend remembers it, the list follows at once. */
export async function setGroupCollapsed(group: ConnectionGroup, collapsed: boolean): Promise<void> {
  queryClient.setQueryData<{ connections: unknown[]; groups: ConnectionGroup[] }>(
    connectionKeys.all,
    (data) =>
      data && {
        ...data,
        groups: data.groups.map((g) => (g.id === group.id ? { ...g, collapsed } : g)),
      },
  );
  try {
    await connectionsApi.setGroupCollapsed(group.id, collapsed);
  } catch (error) {
    showError(error);
    await refreshConnections();
  }
}
