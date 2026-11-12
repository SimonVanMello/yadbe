import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import type { SavedQuery } from '../../ipc';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import {
  copySaved,
  deleteSaved,
  duplicateSaved,
  insertSaved,
  moveSaved,
  openSaved,
  runSaved,
} from './libraryActions';
import { folderOptions } from './libraryModel';
import { queryKey } from './libraryModel';
import { useLibraryUi } from './libraryStore';
import { useSaveDialog } from './saveDialogStore';
import { useSavedLibrary } from './useLibrary';

function MoveItems({ query }: { query: SavedQuery }) {
  const t = useT();
  const { library } = useSavedLibrary();
  const options = folderOptions(library.folders);
  return (
    <>
      <ContextMenuItem
        icon="bookmark"
        disabled={query.folderId === null}
        onSelect={() => {
          void moveSaved(query, null);
        }}
      >
        {t('library.menu.moveRoot')}
      </ContextMenuItem>
      {options.map((folder) => (
        <ContextMenuItem
          key={folder.id}
          icon="folder"
          disabled={query.folderId === folder.id}
          onSelect={() => {
            void moveSaved(query, folder.id);
          }}
        >
          {folder.label}
        </ContextMenuItem>
      ))}
    </>
  );
}

/** What can be done with a saved query: the context menu of its row. */
export function QueryMenu({ query }: { query: SavedQuery }) {
  const shortcutOf = useShortcutOf();
  const t = useT();
  return (
    <>
      <ContextMenuItem
        icon="plus"
        onSelect={() => {
          void openSaved(query);
        }}
      >
        {t('library.menu.open')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="terminal"
        shortcut="Mod+Enter"
        onSelect={() => {
          void insertSaved(query);
        }}
      >
        {t('library.menu.insert')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="play"
        shortcut={shortcutOf('query.run')}
        onSelect={() => {
          void runSaved(query);
        }}
      >
        {t('library.menu.run')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon="pencil"
        onSelect={() => {
          useSaveDialog.getState().open({ mode: 'edit', queryId: query.id });
        }}
      >
        {t('library.menu.edit')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="pencil"
        shortcut="F2"
        onSelect={() => {
          useLibraryUi.getState().startRename(queryKey(query.id));
        }}
      >
        {t('library.menu.rename')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="copy"
        onSelect={() => {
          void duplicateSaved(query);
        }}
      >
        {t('library.menu.duplicate')}
      </ContextMenuItem>
      <ContextMenuSub label={t('library.menu.moveTo')} icon="folder">
        <MoveItems query={query} />
      </ContextMenuSub>
      <ContextMenuItem
        icon="copy"
        onSelect={() => {
          void copySaved(query);
        }}
      >
        {t('library.menu.copy')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon="trash"
        danger
        shortcut="Delete"
        onSelect={() => {
          void deleteSaved(query);
        }}
      >
        {t('library.menu.delete')}
      </ContextMenuItem>
    </>
  );
}
