import { confirm, type ConfirmItem } from '../../app/errors/confirmStore';
import { showError } from '../../app/errors/presentError';
import { queryClient } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import type { ActivitySession, KillMode } from '../../ipc';
import { toast } from '../../ui/toastStore';
import type { ConnectionSummary } from '../connections/model';
import { killSession } from './activityApi';
import { blockingCounts, formatDuration } from './activityModel';
import { activityKeys } from './useActivity';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Opens the activity monitor of a connection (F-140): the one already open, else a new tab. */
export function openActivity(connectionId: string): string {
  return useTabsStore.getState().openToolTab(connectionId, { type: 'activity' });
}

/** Longest statement quoted in a confirmation: the dialog shows what is hit, not the script. */
const QUOTED_STATEMENT_CHARS = 400;

/**
 * What the confirmation of a kill shows (F-140): who, what it runs, since when, and what stops
 * with it. Pure, so that it is tested without a dialog.
 */
export function killConfirmation(
  session: ActivitySession,
  mode: KillMode,
  sessions: readonly ActivitySession[],
): { title: string; description: string; confirmLabel: string; items: ConfirmItem[] } {
  const cancel = mode === 'cancelQuery';
  const items: ConfirmItem[] = [
    {
      label: t('activity.kill.item.session', { id: session.id }),
      note: t('activity.kill.item.who', {
        user: session.user ?? '?',
        client: session.client ?? session.database ?? '?',
      }),
    },
  ];
  if (session.runningSecs !== null) {
    items.push({
      label:
        session.state === 'active'
          ? t('activity.kill.item.running', { duration: formatDuration(session.runningSecs) })
          : t('activity.kill.item.inState', {
              state: t(`activity.state.${session.state}`),
              duration: formatDuration(session.runningSecs),
            }),
    });
  }
  if (!cancel && session.transactionSecs !== null) {
    items.push({
      label: t('activity.kill.item.transaction', {
        duration: formatDuration(session.transactionSecs),
      }),
      danger: true,
    });
  }
  const blocking = blockingCounts(sessions).get(session.id) ?? 0;
  if (blocking > 0) {
    items.push({ label: t('activity.kill.item.blocking', { count: blocking }) });
  }
  if (session.statement) {
    const text = session.statement.trim();
    items.push({
      label:
        text.length > QUOTED_STATEMENT_CHARS ? `${text.slice(0, QUOTED_STATEMENT_CHARS)}…` : text,
      code: true,
    });
  }
  return {
    title: t(cancel ? 'activity.kill.confirm.cancelTitle' : 'activity.kill.confirm.terminateTitle'),
    description: t(
      cancel
        ? 'activity.kill.confirm.cancelDescription'
        : 'activity.kill.confirm.terminateDescription',
    ),
    confirmLabel: t(
      cancel ? 'activity.kill.confirm.cancelAction' : 'activity.kill.confirm.terminateAction',
    ),
    items,
  };
}

/**
 * Asks, then cancels the statement of a session or ends it. The confirmation names the session,
 * what it runs and since when; nothing is sent before the answer. The list is read again
 * afterwards, whatever came out.
 */
export async function killWithConfirmation(
  connection: ConnectionSummary,
  session: ActivitySession,
  mode: KillMode,
  sessions: readonly ActivitySession[],
): Promise<boolean> {
  const { title, description, confirmLabel, items } = killConfirmation(session, mode, sessions);
  const confirmed = await confirm({
    title,
    description,
    confirmLabel,
    danger: true,
    items,
    connection,
  });
  if (!confirmed) return false;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: activityKeys.connection(connection.id) });
  try {
    const outcome = await killSession(connection.id, session, mode);
    toast({
      variant: 'success',
      title: t(
        mode === 'cancelQuery' ? 'activity.kill.done.cancel' : 'activity.kill.done.terminate',
      ),
      description: outcome.statement,
    });
    return true;
  } catch (error) {
    showError(error, {
      title: t('activity.kill.failed'),
      connectionId: connection.id,
      retry: () => {
        void refresh();
      },
    });
    return false;
  } finally {
    void refresh();
  }
}

/** Puts the text of a statement on the clipboard. */
export async function copyStatement(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ variant: 'success', title: t('activity.detail.copied') });
  } catch (error) {
    showError(error, { title: t('explorer.copyFailed') });
  }
}
