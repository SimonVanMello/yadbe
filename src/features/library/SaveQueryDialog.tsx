import { useMemo, useState, type SubmitEvent } from 'react';

import { showError } from '../../app/errors/presentError';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type SavedQuery } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { Switch } from '../../ui/Switch';
import { TextArea } from '../../ui/TextArea';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { useConnection } from '../connections/connectionStore';
import { useQueryTabStore } from '../query/queryTabStore';
import { folderOptions, formatTags, parseTags, suggestName } from './libraryModel';
import styles from './SaveQueryDialog.module.css';
import { useSaveDialog, type SaveDialogRequest } from './saveDialogStore';
import { refreshLibrary, useSavedLibrary, useSavedQuery } from './useLibrary';

const TRIGGER = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** What the form starts from. */
interface Initial {
  name: string;
  folderId: string | null;
  scope: 'global' | 'connection';
  databaseOnly: boolean;
  description: string;
  tags: string;
  sql: string;
  snippet: boolean;
  trigger: string;
}

interface FormProps {
  request: SaveDialogRequest;
  initial: Initial;
  /** Connection and database the "on this connection" scope would bind to. */
  scopeConnectionId: string | null;
  scopeDatabase: string | null;
  onClose: () => void;
}

function SaveForm({ request, initial, scopeConnectionId, scopeDatabase, onClose }: FormProps) {
  const t = useT();
  const { library } = useSavedLibrary();
  const connection = useConnection(scopeConnectionId);
  const [name, setName] = useState(initial.name);
  const [folderId, setFolderId] = useState(initial.folderId ?? '');
  const [scope, setScope] = useState(initial.scope);
  const [databaseOnly, setDatabaseOnly] = useState(initial.databaseOnly);
  const [description, setDescription] = useState(initial.description);
  const [tags, setTags] = useState(initial.tags);
  const [sql, setSql] = useState(initial.sql);
  const [snippet, setSnippet] = useState(initial.snippet);
  const [trigger, setTrigger] = useState(initial.trigger);
  const [saving, setSaving] = useState(false);

  const folders = useMemo(() => folderOptions(library.folders), [library.folders]);
  const trimmedName = name.trim();
  const triggerValid = !snippet || TRIGGER.test(trigger.trim());
  const canSave = trimmedName !== '' && sql.trim() !== '' && triggerValid && !saving;
  const bound = scope === 'connection' && connection !== undefined;
  const editing = request.mode === 'edit';

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const fields = {
      name: trimmedName,
      description: description.trim(),
      tags: parseTags(tags),
      folderId: folderId === '' ? null : folderId,
      connectionId: bound ? connection.id : null,
      database: bound && databaseOnly ? scopeDatabase : null,
      snippetTrigger: snippet ? trigger.trim() : null,
    };
    void (async () => {
      try {
        let saved: SavedQuery;
        if (request.mode === 'edit') {
          saved = await unwrap(
            ipc.commands.updateSavedQuery(request.queryId, {
              ...fields,
              sql: sql === initial.sql ? null : sql,
            }),
          );
        } else {
          saved = await unwrap(ipc.commands.createSavedQuery({ ...fields, sql }));
          // The whole tab saved: it now stands for that query and can update it.
          if (request.tabId && request.selectionOnly !== true) {
            useQueryTabStore
              .getState()
              .setOrigin(request.tabId, { queryId: saved.id, baseline: sql });
          }
        }
        await refreshLibrary();
        toast({
          variant: 'success',
          title: translate(
            useI18nStore.getState().locale,
            editing ? 'library.updated' : 'library.saved',
            { name: saved.name },
          ),
        });
        onClose();
      } catch (error) {
        showError(error, { title: t('library.saveFailed') });
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={editing ? t('library.edit.title') : t('library.save.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="library-save-form" disabled={!canSave}>
            {t('library.save.confirm')}
          </Button>
        </>
      }
    >
      <form id="library-save-form" className={styles.form} onSubmit={submit}>
        <Field label={t('library.save.name')} htmlFor="library-name">
          <TextInput
            id="library-name"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <div className={styles.row}>
          <Field label={t('library.save.folder')} htmlFor="library-folder">
            <Select
              id="library-folder"
              value={folderId}
              options={[
                { value: '', label: t('library.save.folder.none') },
                ...folders.map((folder) => ({
                  value: folder.id,
                  label: folder.label,
                })),
              ]}
              onChange={setFolderId}
            />
          </Field>
          <Field label={t('library.save.scope')}>
            <SegmentedControl
              label={t('library.save.scope')}
              value={bound ? 'connection' : 'global'}
              options={[
                { value: 'global', label: t('library.save.scope.global') },
                ...(connection
                  ? [
                      {
                        value: 'connection' as const,
                        label: t('library.save.scope.connection', { connection: connection.name }),
                      },
                    ]
                  : []),
              ]}
              onChange={setScope}
            />
          </Field>
        </div>
        {bound && scopeDatabase !== null && scopeDatabase !== '' && (
          <Switch
            checked={databaseOnly}
            onCheckedChange={setDatabaseOnly}
            label={t('library.save.scope.database', { database: scopeDatabase })}
          />
        )}
        <Field label={t('library.save.statement')} htmlFor="library-sql">
          <TextArea
            id="library-sql"
            mono
            rows={6}
            value={sql}
            onChange={(event) => {
              setSql(event.target.value);
            }}
          />
          {request.mode === 'create' && request.selectionOnly === true && (
            <span className={styles.note}>{t('library.save.selectionOnly')}</span>
          )}
        </Field>
        <Field label={t('library.save.description')} htmlFor="library-description">
          <TextInput
            id="library-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>
        <Field
          label={t('library.save.tags')}
          htmlFor="library-tags"
          hint={t('library.save.tags.hint')}
        >
          <TextInput
            id="library-tags"
            value={tags}
            onChange={(event) => {
              setTags(event.target.value);
            }}
          />
        </Field>
        <Switch
          checked={snippet}
          onCheckedChange={setSnippet}
          label={t('library.save.snippet')}
          hint={t('library.save.snippet.hint')}
        />
        {snippet && (
          <Field
            label={t('library.save.trigger')}
            htmlFor="library-trigger"
            error={triggerValid ? undefined : t('library.save.trigger.invalid')}
            hint={<span data-testid="snippet-syntax">{t('library.save.syntax')}</span>}
          >
            <TextInput
              id="library-trigger"
              mono
              invalid={!triggerValid}
              value={trigger}
              placeholder="top10"
              onChange={(event) => {
                setTrigger(event.target.value);
              }}
            />
          </Field>
        )}
      </form>
    </Dialog>
  );
}

function initialFor(request: Extract<SaveDialogRequest, { mode: 'create' }>): Initial {
  return {
    name:
      request.name ??
      suggestName(request.sql, translate(useI18nStore.getState().locale, 'library.untitled')),
    folderId: request.folderId ?? null,
    scope: 'global',
    databaseOnly: false,
    description: request.description ?? '',
    tags: '',
    sql: request.sql,
    snippet: request.snippet ?? false,
    trigger: request.trigger ?? '',
  };
}

function CreateDialog({
  request,
  onClose,
}: {
  request: Extract<SaveDialogRequest, { mode: 'create' }>;
  onClose: () => void;
}) {
  const connection = useConnection(request.connectionId);
  const scopeDatabase = request.database ?? (connection?.database ? connection.database : null);
  // Text of another family would not run anywhere else: it is saved on its connection by default.
  const otherFamily = connection !== undefined && connection.family !== 'sql';
  const initial = useMemo(
    () => ({ ...initialFor(request), ...(otherFamily ? { scope: 'connection' as const } : {}) }),
    [request, otherFamily],
  );
  return (
    <SaveForm
      request={request}
      initial={initial}
      scopeConnectionId={request.connectionId}
      scopeDatabase={scopeDatabase}
      onClose={onClose}
    />
  );
}

function EditDialog({
  request,
  onClose,
}: {
  request: Extract<SaveDialogRequest, { mode: 'edit' }>;
  onClose: () => void;
}) {
  const t = useT();
  const loaded = useSavedQuery(request.queryId);
  const activeConnectionId = useTabsStore((state) => selectActiveTab(state).connectionId);
  const query = loaded.data;
  const connectionId = query?.connectionId ?? activeConnectionId;
  const connection = useConnection(connectionId);

  if (!query) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={t('library.edit.title')}
      >
        {loaded.isError || (loaded.isSuccess && !loaded.data) ? (
          <p>{t('library.save.loadFailed')}</p>
        ) : (
          <Spinner />
        )}
      </Dialog>
    );
  }
  const initial: Initial = {
    name: query.name,
    folderId: query.folderId,
    scope: query.connectionId === null ? 'global' : 'connection',
    databaseOnly: query.database !== null,
    description: query.description,
    tags: formatTags(query.tags),
    sql: query.sql,
    snippet: query.snippetTrigger !== null,
    trigger: query.snippetTrigger ?? '',
  };
  return (
    <SaveForm
      key={query.id}
      request={request}
      initial={initial}
      scopeConnectionId={connectionId}
      scopeDatabase={query.database ?? (connection?.database ? connection.database : null)}
      onClose={onClose}
    />
  );
}

/** The dialog that saves a query to the library, or edits the details of a saved one (F-050). */
export function SaveQueryDialog() {
  const request = useSaveDialog((state) => state.request);
  const close = useSaveDialog((state) => state.close);
  if (!request) return null;
  return request.mode === 'create' ? (
    <CreateDialog request={request} onClose={close} />
  ) : (
    <EditDialog request={request} onClose={close} />
  );
}
