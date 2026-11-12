import { lazyComponent } from './lazyModule';

// Parts of the window the first paint does not need (P-01): each is its own chunk, loaded in the
// background once the window is shown (`preloadLazyModules`), or on first render before that.

/** Always mounted and closed at startup: waits for the background load. */
const DIALOG = { onRender: false };

export const LazyConnectionDialog = lazyComponent(
  () => import('../features/connections/ConnectionDialog').then((m) => m.ConnectionDialog),
  DIALOG,
);
export const LazyHostKeyDialog = lazyComponent(
  () => import('../features/connections/HostKeyDialog').then((m) => m.HostKeyDialog),
  DIALOG,
);
export const LazyExportDialog = lazyComponent(
  () => import('../features/export/ExportDialog').then((m) => m.ExportDialog),
  DIALOG,
);
export const LazyObjectActionDialog = lazyComponent(
  () => import('../features/objects/ObjectActionDialog').then((m) => m.ObjectActionDialog),
  DIALOG,
);
export const LazyPropertiesDialog = lazyComponent(
  () => import('../features/objects/PropertiesDialog').then((m) => m.PropertiesDialog),
  DIALOG,
);
export const LazyImportDialog = lazyComponent(
  () => import('../features/import/ImportDialog').then((m) => m.ImportDialog),
  DIALOG,
);
export const LazyConnectionImportDialog = lazyComponent(
  () =>
    import('../features/connections/ConnectionImportDialog').then((m) => m.ConnectionImportDialog),
  DIALOG,
);
export const LazyConnectionExportDialog = lazyComponent(
  () =>
    import('../features/connections/ConnectionExportDialog').then((m) => m.ConnectionExportDialog),
  DIALOG,
);
export const LazySaveQueryDialog = lazyComponent(
  () => import('../features/library/SaveQueryDialog').then((m) => m.SaveQueryDialog),
  DIALOG,
);
export const LazyParameterDialog = lazyComponent(
  () => import('../features/query/ParameterDialog').then((m) => m.ParameterDialog),
  DIALOG,
);
export const LazyKvApplyDialog = lazyComponent(
  () => import('../features/keyvalue/KvApplyDialog').then((m) => m.KvApplyDialog),
  DIALOG,
);
export const LazyKvFormDialog = lazyComponent(
  () => import('../features/keyvalue/KvFormDialog').then((m) => m.KvFormDialog),
  DIALOG,
);
export const LazyDocApplyDialog = lazyComponent(
  () => import('../features/document/DocApplyDialog').then((m) => m.DocApplyDialog),
  DIALOG,
);
export const LazyDocFormDialog = lazyComponent(
  () => import('../features/document/DocFormDialog').then((m) => m.DocFormDialog),
  DIALOG,
);
export const LazyPreferencesDialog = lazyComponent(
  () => import('../features/preferences/PreferencesDialog').then((m) => m.PreferencesDialog),
  DIALOG,
);
export const LazyActivityTabBody = lazyComponent(() =>
  import('../features/activity/ActivityTabBody').then((m) => m.ActivityTabBody),
);
export const LazyMigrationsTabBody = lazyComponent(() =>
  import('../features/migrations/MigrationsTabBody').then((m) => m.MigrationsTabBody),
);
export const LazyKvConsole = lazyComponent(() =>
  import('../features/keyvalue/KvConsole').then((m) => m.KvConsole),
);
export const LazyKeyTabBody = lazyComponent(() =>
  import('../features/keyvalue/KeyTabBody').then((m) => m.KeyTabBody),
);
export const LazyDdlTabBody = lazyComponent(() =>
  import('../features/objects/DdlTabBody').then((m) => m.DdlTabBody),
);
export const LazyPlanView = lazyComponent(() =>
  import('../features/query/PlanView').then((m) => m.PlanView),
);
export const LazyPrimitivesDemo = lazyComponent(
  () => import('../features/demo/PrimitivesDemo').then((m) => m.PrimitivesDemo),
  { preload: false },
);
export const LazyGridDemo = lazyComponent(
  () => import('../features/demo/GridDemo').then((m) => m.GridDemo),
  { preload: false },
);
// The document family's tabs (M4-2): only a MongoDB connection needs them.
export const LazyCollectionTabBody = lazyComponent(() =>
  import('../features/document/CollectionTabBody').then((m) => m.CollectionTabBody),
);
// The mongosh editor (M4-3): CodeMirror's JavaScript mode comes with it.
export const LazyScriptConsole = lazyComponent(() =>
  import('../features/document/ScriptConsole').then((m) => m.ScriptConsole),
);
