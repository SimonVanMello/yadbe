import { useId } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { JsonEditor } from './JsonEditor';
import { closeEditor, stageEditor } from './searchEditActions';
import { documentError } from './searchEditModel';
import { patchEditor, useSearchEditStore } from './searchEditStore';
import styles from './SearchEdit.module.css';

const NONE: readonly string[] = [];

/**
 * The document editor of an index tab (M4-8): the `_source` of one document as JSON, numbers as
 * the server holds them, checked as it is typed. Editing replaces the whole `_source` at the
 * version it was read; adding (or duplicating) creates a document, refused if its `_id` exists.
 * The change is staged, not sent: the tab's pending bar applies it. Mount once.
 */
export function DocEditorDialog() {
  const t = useT();
  const id = useId();
  const editor = useSearchEditStore((state) => state.editor);
  const targets = useSearchEditStore((state) =>
    state.editor ? (state.tabs[state.editor.tabId]?.info?.createTargets ?? NONE) : NONE,
  );
  if (!editor) return null;
  const invalid = editor.loading ? null : documentError(editor.text);
  const position = invalid !== null && invalid !== 'notObject' ? invalid : null;
  const creating = editor.mode === 'create';
  const options = targets.includes(editor.index) ? targets : [editor.index, ...targets];
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closeEditor();
      }}
      title={
        creating
          ? t('search.edit.editor.createTitle')
          : t('search.edit.editor.title', { id: editor.id })
      }
      description={
        creating ? t('search.edit.editor.createDescription') : t('search.edit.editor.description')
      }
      footer={
        <>
          <Button variant="ghost" onClick={closeEditor}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={editor.loading || editor.error !== null || invalid !== null}
            onClick={() => {
              stageEditor();
            }}
          >
            <Icon name="check" />
            {t('search.edit.editor.stage')}
          </Button>
        </>
      }
    >
      <div className={styles.form} data-testid="search-doc-editor">
        <div className={styles.row}>
          <Field label={t('search.edit.editor.index')} htmlFor={`${id}-index`}>
            {creating ? (
              <Select
                id={`${id}-index`}
                value={editor.index}
                options={options.map((name) => ({ value: name, label: name }))}
                onChange={(index) => {
                  patchEditor({ index });
                }}
              />
            ) : (
              <TextInput id={`${id}-index`} mono value={editor.index} readOnly />
            )}
          </Field>
          <Field
            label={t('search.edit.editor.id')}
            htmlFor={`${id}-id`}
            hint={creating ? t('search.edit.editor.idHint') : undefined}
          >
            <TextInput
              id={`${id}-id`}
              data-field="id"
              mono
              value={editor.id}
              readOnly={!creating}
              placeholder={creating ? t('search.edit.editor.idAuto') : undefined}
              onChange={(event) => {
                patchEditor({ id: event.target.value });
              }}
            />
          </Field>
          <Field
            label={t('search.edit.editor.routing')}
            htmlFor={`${id}-routing`}
            hint={creating ? t('search.edit.editor.routingHint') : undefined}
          >
            <TextInput
              id={`${id}-routing`}
              data-field="routing"
              mono
              value={editor.routing}
              readOnly={!creating}
              onChange={(event) => {
                patchEditor({ routing: event.target.value });
              }}
            />
          </Field>
        </div>
        {editor.changedSince && (
          <p className={styles.notice} role="note">
            <Icon name="warning" className={styles.noticeIcon} />
            {t('search.edit.editor.changedSince')}
          </p>
        )}
        {editor.loading ? (
          <div className={styles.loading}>
            <Spinner />
            {t('search.edit.editor.loading')}
          </div>
        ) : editor.error ? (
          <p className={styles.error} role="alert">
            {localize(editor.error.message)}
          </p>
        ) : (
          <Field
            label={t('search.edit.editor.source')}
            error={
              invalid === 'notObject'
                ? t('search.edit.editor.notObject')
                : position
                  ? t('search.edit.editor.invalid', position)
                  : undefined
            }
            hint={editor.guard ? t('search.edit.editor.version', editor.guard) : undefined}
          >
            <JsonEditor
              initial={editor.text}
              label={t('search.edit.editor.source')}
              error={position}
              onChange={(text) => {
                patchEditor({ text });
              }}
            />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
