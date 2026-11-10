import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type ReactNode, type SubmitEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { showError } from '../../app/errors/presentError';
import { useShellStore, type ConnectionDialogRequest } from '../../app/shellStore';
import { translate, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YadbeIpcError, type YadbeError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { ConnectionForm } from './ConnectionForm';
import { connectionsApi } from './connectionsApi';
import styles from './ConnectionDialog.module.css';
import {
  refreshConnections,
  useConnectionList,
  useEngines,
  useKeychainAvailable,
} from './connectionStore';
import {
  applyParsed,
  draftFromSaved,
  emptyDraft,
  validateDraft,
  withEngine,
  type ConnectionDraft,
  type DraftErrors,
  type EngineInfo,
} from './model';
import { pickDatabaseFile } from './pickDatabaseFile';
import { TestResultView, type TestState } from './TestResultView';

function toYadbeError(error: unknown): YadbeError {
  if (error instanceof YadbeIpcError) return error.error;
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message: { en: message, fr: message }, action: null, detail: null };
}

function focusField(name: string): void {
  document.querySelector<HTMLElement>(`[data-field="${name}"]`)?.focus();
}

interface DialogBodyProps {
  initial: ConnectionDraft;
  engines: readonly EngineInfo[];
  onClose: () => void;
}

function DialogBody({ initial, engines, onClose }: DialogBodyProps) {
  const t = useT();
  const groups = useConnectionList().data?.groups ?? [];
  const keychainAvailable = useKeychainAvailable();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<YadbeError | null>(null);
  const [ignoredKeys, setIgnoredKeys] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const editing = initial.id !== null;
  const infoOf = (value: ConnectionDraft) =>
    engines.find((candidate) => candidate.engine === value.engine);
  const info = infoOf(draft);
  // Request id of the test in flight, to cancel it; a finished or replaced test is ignored.
  const testRequest = useRef<string | null>(null);
  // Password the backend still holds from a pasted string: dropped if the form never sends it.
  const pendingId = useRef<string | null>(null);

  const passwordQuery = useQuery({
    queryKey: ['connection-password', initial.id],
    queryFn: () => (initial.id === null ? null : connectionsApi.passwordLocation(initial.id)),
    gcTime: 0,
  });
  const passwordLocation = passwordQuery.data ?? null;

  const forgetPending = () => {
    const id = pendingId.current;
    pendingId.current = null;
    if (id !== null) void connectionsApi.discardPending(id).catch(() => undefined);
  };

  const close = () => {
    if (testRequest.current !== null) {
      void connectionsApi.cancelTest(testRequest.current).catch(() => undefined);
    }
    forgetPending();
    onClose();
  };

  const update = (next: ConnectionDraft) => {
    // Typing a password replaces the one held from a pasted string.
    const typed = next.password !== '' && next.pendingPasswordId !== null;
    const value = typed ? { ...next, pendingPasswordId: null } : next;
    if (typed) forgetPending();
    setDraft(value);
    // Whatever was tested is no longer what the form says.
    if (testRequest.current === null) setTest({ status: 'idle' });
    if (Object.keys(errors).length > 0) setErrors(validateDraft(value, infoOf(value)));
  };

  /** A held password that expired is gone for good: the form must stop offering it. */
  const dropExpiredPending = (error: unknown) => {
    if (!(error instanceof YadbeIpcError) || error.error.code !== 'pendingSecretExpired') return;
    pendingId.current = null;
    setDraft((current) => ({ ...current, pendingPasswordId: null }));
  };

  const fillFrom = (text: string) => {
    if (text.trim() === '' || parsing) return;
    setParsing(true);
    setPasteError(null);
    connectionsApi
      .parseConnectionString(text, draft.engine)
      .then((parsed) => {
        if (parsed.passwordId !== null) {
          // A new string brings a new held password: the previous one is no longer needed.
          forgetPending();
          pendingId.current = parsed.passwordId;
        }
        setIgnoredKeys(parsed.ignoredKeys);
        update(applyParsed(draft, parsed, engines));
        setPasted('');
      })
      .catch((error: unknown) => {
        setPasteError(toYadbeError(error));
      })
      .finally(() => {
        setParsing(false);
      });
  };

  const runTest = () => {
    const found = validateDraft(draft, info);
    setErrors(found);
    if (Object.keys(found).length > 0 || !info) return;
    const requestId = crypto.randomUUID();
    testRequest.current = requestId;
    setTest({ status: 'running' });
    connectionsApi
      .test(requestId, draft, info)
      .then((result) => {
        if (testRequest.current === requestId) setTest({ status: 'ok', result });
      })
      .catch((error: unknown) => {
        dropExpiredPending(error);
        // A test the user cancelled, or replaced by another one, is not worth showing.
        if (testRequest.current !== requestId) return;
        setTest({ status: 'error', error: toYadbeError(error) });
      })
      .finally(() => {
        if (testRequest.current === requestId) testRequest.current = null;
      });
  };

  const cancelTest = () => {
    const requestId = testRequest.current;
    testRequest.current = null;
    setTest({ status: 'idle' });
    if (requestId !== null) void connectionsApi.cancelTest(requestId).catch(() => undefined);
  };

  const pickFile = () => {
    void pickDatabaseFile().then((filePath) => {
      if (filePath) update({ ...draft, filePath });
    });
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const found = validateDraft(draft, info);
    setErrors(found);
    if (Object.keys(found).length > 0 || saving || !info) return;
    setSaving(true);
    connectionsApi
      .save(draft, info, passwordLocation)
      .then(async (saved) => {
        // The backend consumed the held password with this save.
        pendingId.current = null;
        await refreshConnections();
        toast({
          variant: 'success',
          title: translate(useI18nStore.getState().locale, 'connection.saved', {
            name: saved.definition.name,
          }),
        });
        onClose();
      })
      .catch((error: unknown) => {
        dropExpiredPending(error);
        showError(error, {
          title: t('connection.saveFailed'),
          enterPassword: () => {
            focusField('password');
          },
        });
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const testing = test.status === 'running';

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={editing ? t('connection.edit.title') : t('connection.new.title')}
      description={editing ? undefined : t('connection.new.description')}
      notice={
        test.status === 'idle' ? undefined : (
          <TestResultView
            state={test}
            context={{
              retry: runTest,
              editConnection: () => {
                focusField(info?.capabilities.usesFile ? 'file' : 'host');
              },
              changeTlsMode: () => {
                focusField('tls');
              },
              enterPassword: () => {
                focusField('password');
              },
              chooseFile: pickFile,
            }}
          />
        )
      }
      footer={
        <>
          <Button
            className={styles.testButton}
            onClick={testing ? cancelTest : runTest}
            disabled={!info}
          >
            {testing ? <Spinner /> : <Icon name="play" />}
            {testing ? t('connection.test.cancel') : t('connection.test')}
          </Button>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="connection-form" disabled={saving || !info}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="connection-form" className={styles.body} onSubmit={submit} noValidate>
        <Field
          label={t('connection.string')}
          htmlFor="connection-string"
          hint={t('connection.string.hint')}
        >
          <div className={styles.pasteRow}>
            <TextInput
              id="connection-string"
              mono
              value={pasted}
              placeholder="postgres://user:password@host:5432/database"
              onChange={(event) => {
                setPasted(event.target.value);
                setPasteError(null);
              }}
              onPaste={(event) => {
                // A pasted string fills the form at once, no extra click.
                const text = event.clipboardData.getData('text');
                if (text.trim() === '') return;
                event.preventDefault();
                setPasted(text);
                fillFrom(text);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  fillFrom(pasted);
                }
              }}
            />
            <Button
              disabled={pasted.trim() === '' || parsing}
              onClick={() => {
                fillFrom(pasted);
              }}
            >
              {t('connection.string.fill')}
            </Button>
          </div>
        </Field>
        {pasteError && (
          <ErrorPanel compact title={t('connection.string.failed')} error={pasteError} />
        )}
        {ignoredKeys.length > 0 && (
          <p className={styles.ignored} role="note">
            {t('connection.string.ignored', { keys: ignoredKeys.join(', ') })}
          </p>
        )}
        <ConnectionForm
          draft={draft}
          engines={engines}
          groups={groups}
          errors={errors}
          passwordLocation={passwordLocation}
          keychainAvailable={keychainAvailable}
          onChange={update}
          onPasteConnectionString={fillFrom}
          onPickFile={pickFile}
        />
      </form>
    </Dialog>
  );
}

function LoadedDialog({
  request,
  onClose,
}: {
  request: ConnectionDialogRequest;
  onClose: () => void;
}) {
  const t = useT();
  const { connectionId } = request;
  const list = useConnectionList();
  const { engines, isError: enginesFailed, error: enginesError } = useEngines();

  const shell = (children: ReactNode, footer?: ReactNode) => (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={connectionId === null ? t('connection.new.title') : t('connection.edit.title')}
      footer={footer ?? <Button onClick={onClose}>{t('common.close')}</Button>}
    >
      {children}
    </Dialog>
  );

  if (enginesFailed || list.isError) {
    return shell(
      <ErrorPanel
        compact
        title={t('connection.loadFailed')}
        error={toYadbeError(enginesError ?? list.error)}
      />,
    );
  }
  if (engines.length === 0 || !list.isSuccess) {
    return shell(
      <div className={styles.loading}>
        <Spinner />
        {t('connection.loading')}
      </div>,
      <Button onClick={onClose}>{t('common.cancel')}</Button>,
    );
  }

  const saved =
    connectionId === null ? undefined : list.data.saved.find((c) => c.id === connectionId);
  if (connectionId !== null && !saved) {
    // Deleted while the dialog was opening.
    return shell(<p className={styles.loading}>{t('tab.body.missing')}</p>);
  }
  let initial: ConnectionDraft;
  if (saved) {
    initial = draftFromSaved(saved);
  } else {
    const first = engines.find((candidate) => candidate.available) ?? engines[0];
    if (!first) return null;
    const wanted = engines.find((candidate) => candidate.engine === request.engine) ?? first;
    initial = {
      ...withEngine(emptyDraft(first), wanted, first),
      groupId: request.groupId ?? null,
      ...(request.filePath === undefined ? {} : { filePath: request.filePath }),
    };
  }
  return <DialogBody initial={initial} engines={engines} onClose={onClose} />;
}

/** Create / edit dialog of a connection (F-001, F-004 to F-009). Mount once in the shell. */
export function ConnectionDialog() {
  const request = useShellStore((state) => state.connectionDialog);
  const close = useShellStore((state) => state.closeConnectionDialog);
  if (!request) return null;
  return <LoadedDialog key={request.connectionId ?? 'new'} request={request} onClose={close} />;
}
