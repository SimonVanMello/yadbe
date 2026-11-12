import { useCallback, useMemo } from 'react';

import { useT } from '../../i18n/useT';
import { ipc, unwrap, type CollectionPage } from '../../ipc';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { DocumentsView, type DocShown, type DocumentsEditing } from '../documents/DocumentsView';
import type { DocRow } from '../documents/docTree';
import { parseJson } from '../grid/jsonTree';
import type { DocumentViewMode } from './collectionStore';
import {
  deleteTargets,
  duplicate,
  editDocument,
  editField,
  editValueAsJson,
  newDocument,
  removeElement,
  removeNewDocument,
  revertTarget,
  stageField,
  undeleteTarget,
  type EditBlock,
} from './docEditActions';
import { changedFields, editableText, effective, type Target } from './docEditModel';
import { useTabDocEdits } from './docEditStore';
import { EditableDocumentGrid } from './EditableDocumentGrid';
import { ejsonDocument, ejsonNode } from './ejsonView';
import { DocumentResults } from './DocumentResults';

interface EditableDocumentsProps {
  tabId: string;
  page: CollectionPage;
  view: DocumentViewMode;
  label: string;
  /** Why nothing can be changed, or `null`. */
  block: EditBlock | null;
  /** A capped collection: documents cannot be deleted. */
  capped: boolean;
}

/**
 * The documents of a collection tab's page, editable (M4-4) unless `block` says why not: the
 * grid or the documents view, both showing the pending changes.
 */
export function EditableDocuments({
  tabId,
  page,
  view,
  label,
  block,
  capped,
}: EditableDocumentsProps) {
  const t = useT();
  const edits = useTabDocEdits(tabId);
  const { documentsId } = page.documents;
  const count = page.documents.count;

  const load = useCallback(
    async (offset: number, limit: number) =>
      (await unwrap(ipc.commands.mongoFetchDocuments(documentsId, offset, limit))).map(
        ejsonDocument,
      ),
    [documentsId],
  );

  const target = useCallback(
    async (index: number): Promise<Target | null> => {
      const id = page.ids[index];
      if (id === undefined || id === null) return null;
      const [original] = await unwrap(ipc.commands.mongoFetchDocuments(documentsId, index, 1));
      return original === undefined ? null : { id, original };
    },
    [documentsId, page.ids],
  );

  const editing: DocumentsEditing = useMemo(() => {
    const shownOf = (index: number): DocShown | undefined => {
      const id = page.ids[index];
      const edit = id ? edits.documents.get(id) : undefined;
      if (!edit) return undefined;
      const after = effective(edit);
      const node = after ? ejsonNode(after) : ejsonDocument(edit.original);
      const changed: (string | number)[][] =
        edit.replacement !== null
          ? [...changedFields(parseJson(edit.original), after ?? undefined)].map((name) => [name])
          : [...edit.fields.values()].map((f) => [...f.path]);
      return { node, state: edit.deleted ? 'deleted' : 'modified', changed };
    };
    const added = edits.inserts.map((insert) => ejsonDocument(insert.document));
    const on = (row: DocRow, action: (target: Target) => void) => {
      void target(row.document).then((found) => {
        if (found) action(found);
      });
    };
    const onEdit = (row: DocRow, isNew: boolean) => {
      if (isNew) {
        const insert = edits.inserts[row.document - count];
        if (insert) newDocument(tabId, editableText(insert.document), insert.key);
        return;
      }
      if (row.path[0] === '_id') return;
      on(row, (found) => {
        if (row.path.length === 0) editDocument(tabId, found);
        else if (row.node.type === 'scalar') editField(tabId, found, row.path);
        else editValueAsJson(tabId, found, row.path);
      });
    };
    const menu = (row: DocRow, isNew: boolean) => {
      if (isNew) {
        const insert = edits.inserts[row.document - count];
        if (!insert) return null;
        return (
          <>
            <ContextMenuItem
              icon="pencil"
              onSelect={() => {
                newDocument(tabId, editableText(insert.document), insert.key);
              }}
            >
              {t('mongo.edit.editJson')}
            </ContextMenuItem>
            <ContextMenuItem
              icon="trash"
              onSelect={() => {
                removeNewDocument(tabId, insert.key);
              }}
            >
              {t('mongo.edit.removeNew')}
            </ContextMenuItem>
          </>
        );
      }
      const id = page.ids[row.document];
      if (id === undefined || id === null) return null;
      const edit = edits.documents.get(id);
      const deleted = edit?.deleted === true;
      const field = row.path.length > 0;
      const isId = row.path[0] === '_id';
      const element = typeof row.path[row.path.length - 1] === 'number';
      const objectish = row.node.type === 'object' || row.path.length === 0;
      return (
        <>
          {field && !isId && (
            <ContextMenuItem
              icon="pencil"
              disabled={deleted}
              onSelect={() => {
                on(row, (found) => {
                  if (row.node.type === 'scalar') editField(tabId, found, row.path);
                  else editValueAsJson(tabId, found, row.path);
                });
              }}
            >
              {row.node.type === 'scalar'
                ? t('mongo.edit.editValue')
                : t('mongo.edit.editValueJson')}
            </ContextMenuItem>
          )}
          {field && !isId && row.node.type === 'scalar' && (
            <ContextMenuItem
              disabled={deleted}
              onSelect={() => {
                on(row, (found) => {
                  editValueAsJson(tabId, found, row.path);
                });
              }}
            >
              {t('mongo.edit.editValueJson')}
            </ContextMenuItem>
          )}
          {objectish && (
            <ContextMenuItem
              icon="plus"
              disabled={deleted}
              onSelect={() => {
                on(row, (found) => {
                  editField(tabId, found, row.path, true);
                });
              }}
            >
              {t('mongo.edit.addField')}
            </ContextMenuItem>
          )}
          {field && !isId && (
            <ContextMenuItem
              disabled={deleted}
              onSelect={() => {
                on(row, (found) => {
                  if (element) removeElement(tabId, found, row.path);
                  else stageField(tabId, found, row.path, null);
                });
              }}
            >
              {element ? t('mongo.edit.removeElement') : t('mongo.edit.unsetField')}
            </ContextMenuItem>
          )}
          {!field && (
            <>
              <ContextMenuItem
                icon="file"
                disabled={deleted}
                onSelect={() => {
                  on(row, (found) => {
                    editDocument(tabId, found);
                  });
                }}
              >
                {t('mongo.edit.editJson')}
              </ContextMenuItem>
              <ContextMenuItem
                icon="copy"
                onSelect={() => {
                  on(row, (found) => {
                    duplicate(tabId, found);
                  });
                }}
              >
                {t('mongo.edit.duplicate')}
              </ContextMenuItem>
              {deleted ? (
                <ContextMenuItem
                  icon="undo"
                  onSelect={() => {
                    undeleteTarget(tabId, id);
                  }}
                >
                  {t('mongo.edit.undelete')}
                </ContextMenuItem>
              ) : (
                <ContextMenuItem
                  icon="trash"
                  disabled={capped}
                  onSelect={() => {
                    on(row, (found) => {
                      deleteTargets(tabId, [found]);
                    });
                  }}
                >
                  {t('mongo.edit.delete')}
                </ContextMenuItem>
              )}
            </>
          )}
          {edit && (
            <ContextMenuItem
              icon="undo"
              onSelect={() => {
                revertTarget(tabId, id);
              }}
            >
              {t('mongo.edit.revertDocument')}
            </ContextMenuItem>
          )}
        </>
      );
    };
    return {
      document: shownOf,
      added,
      version: JSON.stringify([
        documentsId,
        [...edits.documents.values()].map((e) => [
          e.id,
          e.deleted,
          e.replacement,
          [...e.fields.keys()],
          [...e.fields.values()].map((f) => f.value),
        ]),
        edits.inserts,
      ]),
      menu,
      onEdit,
    };
  }, [edits, page.ids, documentsId, count, tabId, target, t, capped]);

  if (block) return <DocumentResults result={page.documents} view={view} label={label} />;
  if (view === 'documents') {
    return (
      <DocumentsView key={documentsId} count={count} load={load} label={label} editing={editing} />
    );
  }
  return <EditableDocumentGrid tabId={tabId} page={page} label={label} noDelete={capped} />;
}
