import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { YadbeIpcError, type ErrorAction, type LocalizedText, type YadbeError } from '../../ipc';
import { toast, type ToastAction } from '../../ui/toastStore';
import { useShellStore } from '../shellStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** Text of a backend message in the current UI language. */
export function localize(text: LocalizedText): string {
  return text[useI18nStore.getState().locale];
}

/**
 * What each suggested action does where the error is shown. An action with no handler here is
 * not offered, except `editConnection` and `changeTlsMode`, which open the connection form when
 * the error knows its `connectionId`.
 */
export interface ErrorContext {
  /** Short summary of what failed ("Could not connect to pg-eu"); defaults to the message. */
  title?: string;
  /** Saved connection the error is about: its form opens for `editConnection`. */
  connectionId?: string;
  retry?: () => void;
  reconnect?: () => void;
  enterPassword?: () => void;
  editConnection?: () => void;
  changeTlsMode?: () => void;
  chooseFile?: () => void;
}

export interface ResolvedErrorAction {
  label: string;
  run: () => void;
}

/**
 * Turns the action suggested by a typed error into a label and a handler, or `null` when it
 * cannot be offered in this context (e.g. `retry` without a retry function).
 */
export function resolveErrorAction(
  action: ErrorAction | null,
  context: ErrorContext = {},
): ResolvedErrorAction | null {
  if (!action) return null;
  const openForm = () => {
    const { connectionId } = context;
    return connectionId === undefined
      ? undefined
      : () => {
          useShellStore.getState().openConnectionDialog({ connectionId });
        };
  };
  const handlers: Record<ErrorAction, (() => void) | undefined> = {
    retry: context.retry,
    reconnect: context.reconnect,
    enterPassword: context.enterPassword,
    editConnection: context.editConnection ?? openForm(),
    changeTlsMode: context.changeTlsMode ?? openForm(),
    chooseFile: context.chooseFile,
  };
  const run = handlers[action];
  return run ? { label: t(`error.action.${action}`), run } : null;
}

/** Shows a typed backend error as a persistent toast with its suggested action (F-124). */
export function showYadbeError(error: YadbeError, context: ErrorContext = {}): number {
  const action = resolveErrorAction(error.action, context);
  const toastAction: ToastAction | undefined = action
    ? { label: action.label, onClick: action.run }
    : undefined;
  const message = localize(error.message);
  return toast({
    variant: 'error',
    title: context.title ?? message,
    description: context.title ? message : undefined,
    detail: error.detail ?? undefined,
    action: toastAction,
  });
}

/** Shows any thrown value: typed errors get their action, other errors a generic message. */
export function showError(error: unknown, context: ErrorContext = {}): void {
  if (error instanceof YadbeIpcError) {
    showYadbeError(error.error, context);
    return;
  }
  console.error(error);
  toast({
    variant: 'error',
    title: context.title ?? t('error.unexpected'),
    detail: error instanceof Error ? error.message : String(error),
  });
}
