import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { findOverflows, linesOf, rowsOf, sidewaysScrolls } from './overflow';

/**
 * Nothing sticks out of its box (M3-18): the screens are laid out at several window sizes and in
 * both languages (French strings are the longer ones), then `findOverflows` looks for text cut
 * without an ellipsis, children drawn past their parent and anything past the window's edge.
 * Captures go to test-results/.
 *
 * `YADBE_OVERFLOW_AUDIT=1 pnpm test:ui e2e/overflow.spec.ts` runs every screen in both languages
 * at every size and only reports what it finds (the audit, about 10 minutes); without it, the
 * regression check runs every screen in French at 1024×640 and in English at the window's
 * minimum size, and fails on any finding.
 */

const AUDIT = process.env.YADBE_OVERFLOW_AUDIT === '1';
// `YADBE_OVERFLOW_THEME=paper` runs the same screens in the light theme (default: graphite, dark).
const THEME = process.env.YADBE_OVERFLOW_THEME === 'paper' ? 'light' : 'dark';
const LOCALES = ['en', 'fr'] as const;
type Locale = (typeof LOCALES)[number];
interface Layout {
  locale: Locale;
  width: number;
  height: number;
}
// The window's minimum size (tauri.conf.json), small laptops, the default window, larger ones.
const SIZES = [
  { width: 900, height: 560 },
  { width: 1024, height: 640 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const LAYOUTS: Layout[] = AUDIT
  ? LOCALES.flatMap((locale) => SIZES.map((size) => ({ locale, ...size })))
  : [
      { locale: 'fr', width: 1024, height: 640 },
      { locale: 'en', width: 900, height: 560 },
      // M4-15: the default window's width, in both languages.
      { locale: 'fr', width: 1280, height: 720 },
      { locale: 'en', width: 1280, height: 720 },
    ];

const catalogs: Record<Locale, Record<string, string>> = {
  en: JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8')) as Record<
    string,
    string
  >,
  fr: JSON.parse(readFileSync(new URL('../src/i18n/fr.json', import.meta.url), 'utf8')) as Record<
    string,
    string
  >,
};

interface Ctx {
  page: Page;
  /** The label the UI shows for a catalog key, in the locale under test. */
  tr: (key: string) => string;
}

const LONG = 'warehouse_reporting_replica_eu_west_3_with_a_name_much_longer_than_usual_for_tests';

const tree = (page: Page) => page.locator('[role=tree]').first();
const treeItem = (page: Page, name: string | RegExp) =>
  tree(page).getByRole('treeitem', {
    name: typeof name === 'string' ? new RegExp(`^${name}`) : name,
  });

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function connect({ page }: Ctx, name: RegExp) {
  await treeItem(page, name).dblclick();
  await expect(treeItem(page, name)).toHaveAttribute('aria-label', /, (Connected|Connectée)/);
}

async function contextMenu(ctx: Ctx, row: Locator, key: string) {
  await row.click({ button: 'right' });
  await ctx.page
    .getByRole('menuitem', { name: ctx.tr(key) })
    .first()
    .click();
}

async function runSql(ctx: Ctx, sql: string) {
  const editor = ctx.page.locator('.cm-content').first();
  await editor.click();
  await ctx.page.keyboard.press('ControlOrMeta+a');
  await ctx.page.keyboard.press('Delete');
  await ctx.page.keyboard.insertText(sql);
  await ctx.page.keyboard.press('ControlOrMeta+Enter');
}

async function openOrders(ctx: Ctx) {
  await connect(ctx, /^local postgres,/);
  await expect(treeItem(ctx.page, /^public$/).first()).toBeVisible();
  await expand(treeItem(ctx.page, /^shop$/).last());
  await expand(treeItem(ctx.page, /^Tables? \(/).last());
  await treeItem(ctx.page, /^orders$/).dblclick();
  await expect(ctx.page.locator('[role=grid]').first()).toBeVisible();
}

/** The sidebar at its minimum width (200 px), with the keyboard of its resizer. */
async function narrowSidebar({ page }: Ctx) {
  const resizer = page.locator('[role=separator][aria-orientation=vertical]').first();
  await resizer.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
}

async function sidebarView({ page, tr }: Ctx, key: string) {
  await page
    .getByRole('tablist', { name: tr('history.view.label') })
    .getByRole('tab', { name: tr(key) })
    .click();
}

/** A connection whose name is far longer than usual, saved through the dialog. */
async function longConnection(ctx: Ctx) {
  const { page, tr } = ctx;
  await page
    .getByRole('button', { name: tr('connection.new') })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(tr('connection.host'), { exact: true }).fill(`${LONG}.example.com`);
  await dialog.getByLabel(tr('connection.name'), { exact: true }).fill(LONG);
  await dialog.getByRole('textbox', { name: tr('connection.password'), exact: true }).fill('pw');
  await dialog.getByRole('button', { name: tr('common.save') }).click();
  await expect(dialog).toBeHidden();
}

interface Screen {
  name: string;
  prepare: (ctx: Ctx) => Promise<void>;
  /** What the screen must show besides fitting its boxes. */
  check?: (ctx: Ctx) => Promise<void>;
}

/** A dialog never scrolls sideways: no horizontal scrollbar under its form (M4-15). */
async function noSidewaysScroll({ page }: Ctx) {
  expect(await sidewaysScrolls(page.getByRole('dialog'))).toEqual([]);
}

/** A toolbar stays on one row (it drops or shortens things when narrow, it does not wrap). */
async function oneRow(page: Page, testId: string) {
  const bar = page.getByTestId(testId);
  await expect(bar).toBeVisible();
  expect(await rowsOf(bar), `${testId} wraps onto several rows`).toBe(1);
}

/** A note beside the toolbar's controls takes one line (its full text in a tooltip). */
async function oneLine(page: Page, testId: string) {
  const note = page.getByTestId(testId);
  await expect(note).toBeVisible();
  expect(await linesOf(note), `${testId} takes several lines`).toBe(1);
}

async function openCollection(ctx: Ctx, name: RegExp) {
  await connect(ctx, /^catalog · mongo,/);
  await treeItem(ctx.page, name).dblclick();
  await expect(ctx.page.getByTestId('collection-tab')).toBeVisible();
  await expect(ctx.page.getByTestId('collection-range')).toBeVisible();
  await ctx.page.waitForTimeout(300);
}

/** Marks a connection read-only through its dialog (the edit then shows why it cannot change). */
async function makeReadOnly(ctx: Ctx, name: RegExp) {
  const { page, tr } = ctx;
  await contextMenu(ctx, treeItem(page, name), 'connection.menu.edit');
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: new RegExp(`^${tr('connection.section.environment')}`) })
    .click();
  await dialog.getByRole('switch', { name: tr('connection.readOnly') }).click();
  await dialog.getByRole('button', { name: tr('common.save') }).click();
  await expect(dialog).toBeHidden();
}

async function openIndex(ctx: Ctx) {
  await connect(ctx, /^search · logs,/);
  await treeItem(ctx.page, /^orders$/)
    .first()
    .dblclick();
  await expect(ctx.page.getByTestId('index-tab')).toBeVisible();
  await expect(ctx.page.getByTestId('index-range')).toBeVisible();
  await ctx.page.waitForTimeout(300);
}

async function openKey(ctx: Ctx) {
  await connect(ctx, /^cache,/);
  await expand(treeItem(ctx.page, /^config$/).first());
  await treeItem(ctx.page, /^feature-flags/)
    .first()
    .dblclick();
  await expect(ctx.page.getByTestId('kv-edit-bar')).toBeVisible();
  await ctx.page.waitForTimeout(300);
}

async function documentsView({ page, tr }: Ctx) {
  await page.getByRole('radio', { name: tr('mongo.view.documents') }).click();
}

const SCREENS: Screen[] = [
  { name: 'welcome', prepare: async () => {} },
  {
    name: 'connection-dialog',
    prepare: async ({ page, tr }) => {
      await page
        .getByRole('button', { name: tr('connection.new') })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
    check: noSidewaysScroll,
  },
  // Every engine's form: the engine choice and what connecting needs fit the dialog (M4-15).
  ...[
    'SQL Server',
    'MySQL / MariaDB',
    'SQLite',
    'Redis / Valkey',
    'MongoDB',
    'Elasticsearch / OpenSearch',
  ].map((engine): Screen => ({
    name: `connection-dialog-${(engine.split(/[ /]/)[0] ?? engine).toLowerCase()}`,
    prepare: async ({ page, tr }) => {
      await page
        .getByRole('button', { name: tr('connection.new') })
        .first()
        .click();
      await page
        .getByRole('dialog')
        .getByLabel(tr('connection.engine'), { exact: true })
        .selectOption({ label: engine });
    },
    check: noSidewaysScroll,
  })),
  {
    name: 'connection-dialog-sections',
    prepare: async ({ page, tr }) => {
      await page
        .getByRole('button', { name: tr('connection.new') })
        .first()
        .click();
      const dialog = page.getByRole('dialog');
      for (const key of [
        'connection.section.environment',
        'connection.section.tls',
        'connection.ssh',
        'connection.section.advanced',
      ]) {
        await dialog
          .getByRole('button', { name: new RegExp(`^${tr(key).replace(/[()]/g, '\\$&')}`) })
          .click();
      }
      await dialog.getByRole('switch', { name: tr('connection.ssh.enable') }).click();
    },
    check: noSidewaysScroll,
  },
  {
    name: 'connection-edit-prod',
    prepare: async (ctx) => {
      await contextMenu(ctx, treeItem(ctx.page, /^shop · prod,/), 'connection.menu.edit');
      await expect(ctx.page.getByRole('dialog')).toBeVisible();
    },
    check: noSidewaysScroll,
  },
  {
    name: 'sidebar-history',
    prepare: async ({ page, tr }) => {
      await page
        .getByRole('tablist', { name: tr('history.view.label') })
        .getByRole('tab', { name: tr('history.title') })
        .click();
    },
  },
  {
    name: 'sidebar-saved',
    prepare: async ({ page, tr }) => {
      await page
        .getByRole('tablist', { name: tr('history.view.label') })
        .getByRole('tab', { name: tr('library.tab') })
        .click();
    },
  },
  {
    name: 'sidebar-journal',
    prepare: async ({ page, tr }) => {
      await page
        .getByRole('tablist', { name: tr('history.view.label') })
        .getByRole('tab', { name: tr('journal.tab') })
        .click();
    },
  },
  {
    name: 'narrow-sidebar-connections',
    prepare: async (ctx) => {
      await longConnection(ctx);
      await connect(ctx, /^local postgres,/);
      await narrowSidebar(ctx);
    },
  },
  {
    name: 'narrow-sidebar-history',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      await runSql(ctx, `select * from shop.orders where note = '${LONG}';`);
      await narrowSidebar(ctx);
      await sidebarView(ctx, 'history.title');
    },
  },
  {
    name: 'narrow-sidebar-saved',
    prepare: async (ctx) => {
      await narrowSidebar(ctx);
      await sidebarView(ctx, 'library.tab');
    },
  },
  {
    name: 'narrow-sidebar-journal',
    prepare: async (ctx) => {
      await narrowSidebar(ctx);
      await sidebarView(ctx, 'journal.tab');
    },
  },
  {
    name: 'query-results',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      await runSql(ctx, 'select * from shop.orders;');
      await expect(ctx.page.locator('[role=grid]').first()).toBeVisible();
    },
    // From 1024 px on, the toolbar drops labels before it cuts the connection's name; only the
    // window's minimum width (900 px) may cut it, with an ellipsis.
    check: async ({ page }) => {
      if ((page.viewportSize()?.width ?? 0) < 1000) return;
      const name = page.getByTestId('connection-switcher').getByText('local postgres');
      await expect(name).toBeVisible();
      expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    },
  },
  {
    name: 'query-error',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      await runSql(ctx, `select * from ${LONG}_and_more_so_that_the_error_message_is_long;`);
      await ctx.page.waitForTimeout(500);
    },
  },
  {
    name: 'table-tab',
    prepare: async (ctx) => {
      await openOrders(ctx);
    },
  },
  {
    name: 'many-tabs',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      for (let i = 0; i < 12; i++) {
        await contextMenu(ctx, treeItem(ctx.page, /^local postgres,/), 'connection.menu.newQuery');
      }
    },
  },
  {
    name: 'long-connection-name',
    prepare: async (ctx) => {
      await longConnection(ctx);
      await connect(ctx, new RegExp(`^${LONG},`));
    },
  },
  {
    name: 'preferences',
    prepare: async ({ page, tr }) => {
      await page.getByRole('button', { name: tr('preferences.open') }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'palette',
    prepare: async ({ page }) => {
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'activity',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      await contextMenu(ctx, treeItem(ctx.page, /^local postgres,/), 'connection.menu.activity');
      await ctx.page.waitForTimeout(500);
    },
  },
  {
    name: 'password-prompt',
    prepare: async ({ page }) => {
      await treeItem(page, /^auth failure demo,/).dblclick();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'mongo-collection',
    prepare: async (ctx) => {
      await connect(ctx, /^catalog · mongo,/);
      await treeItem(ctx.page, /^orders$/).dblclick();
      await expect(ctx.page.getByTestId('collection-tab')).toBeVisible();
      await ctx.page.waitForTimeout(300);
    },
  },
  {
    name: 'mongo-collection-documents',
    prepare: async (ctx) => {
      await openCollection(ctx, /^orders$/);
      await documentsView(ctx);
    },
    check: async ({ page }) => {
      await oneRow(page, 'collection-bar');
    },
  },
  {
    name: 'mongo-collection-read-only',
    prepare: async (ctx) => {
      await openCollection(ctx, /^metrics$/);
      await documentsView(ctx);
      await expect(ctx.page.getByTestId('doc-edit-blocked')).toBeVisible();
    },
    check: async ({ page }) => {
      await oneRow(page, 'collection-bar');
      await oneLine(page, 'doc-edit-blocked');
    },
  },
  {
    name: 'mongo-console',
    prepare: async (ctx) => {
      await connect(ctx, /^catalog · mongo,/);
      await contextMenu(ctx, treeItem(ctx.page, /^catalog · mongo,/), 'connection.menu.newQuery');
      await expect(ctx.page.getByTestId('script-editor')).toBeVisible();
    },
  },
  {
    name: 'redis-console',
    prepare: async ({ page }) => {
      await treeItem(page, /^cache,/).dblclick();
      await expect(page.getByTestId('kv-console-editor')).toBeVisible();
    },
  },
  {
    name: 'search-console',
    prepare: async ({ page }) => {
      await treeItem(page, /^search · logs,/).dblclick();
      await expect(page.getByTestId('search-console-editor')).toBeVisible();
    },
  },
  {
    name: 'search-index',
    prepare: async (ctx) => {
      await connect(ctx, /^search · logs,/);
      await treeItem(ctx.page, /^orders$/)
        .first()
        .dblclick();
      await expect(ctx.page.getByTestId('index-tab')).toBeVisible();
      await ctx.page.waitForTimeout(300);
    },
  },
  {
    name: 'search-index-documents',
    prepare: async (ctx) => {
      await openIndex(ctx);
      await ctx.page.getByRole('radio', { name: ctx.tr('search.view.documents') }).click();
    },
    check: async ({ page }) => {
      await oneRow(page, 'index-bar');
      await oneRow(page, 'search-edit-bar');
    },
  },
  {
    name: 'search-index-read-only',
    prepare: async (ctx) => {
      await makeReadOnly(ctx, /^search · logs,/);
      await openIndex(ctx);
      await expect(ctx.page.getByTestId('search-read-only')).toBeVisible();
    },
    check: async ({ page }) => {
      await oneRow(page, 'index-bar');
      await oneRow(page, 'search-edit-bar');
      await oneLine(page, 'search-read-only');
    },
  },
  {
    name: 'redis-key-edit',
    prepare: async (ctx) => {
      await openKey(ctx);
    },
    check: async ({ page }) => {
      await oneRow(page, 'kv-edit-bar');
    },
  },
  {
    name: 'redis-key-read-only',
    prepare: async (ctx) => {
      await makeReadOnly(ctx, /^cache,/);
      await openKey(ctx);
    },
    check: async ({ page }) => {
      await oneRow(page, 'kv-edit-bar');
      await oneLine(page, 'kv-read-only');
    },
  },
  {
    name: 'redis-key',
    prepare: async (ctx) => {
      await connect(ctx, /^cache,/);
      await expand(treeItem(ctx.page, /^config$/).first());
      await treeItem(ctx.page, /^feature-flags/)
        .first()
        .dblclick();
      await ctx.page.waitForTimeout(300);
    },
  },
  {
    name: 'export-dialog',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      await runSql(ctx, 'select * from shop.orders;');
      await ctx.page
        .getByRole('button', { name: ctx.tr('export.menu') })
        .first()
        .click();
      await expect(ctx.page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'import-wizard',
    prepare: async (ctx) => {
      await openOrders(ctx);
      await contextMenu(ctx, treeItem(ctx.page, /^orders$/), 'explorer.menu.import');
      await expect(ctx.page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'properties',
    prepare: async (ctx) => {
      await openOrders(ctx);
      await contextMenu(ctx, treeItem(ctx.page, /^orders$/), 'explorer.menu.properties');
      await expect(ctx.page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'drop',
    prepare: async (ctx) => {
      await openOrders(ctx);
      await contextMenu(ctx, treeItem(ctx.page, /^orders$/), 'explorer.menu.drop');
      await expect(ctx.page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'save-query',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      await runSql(ctx, `-- ${LONG}\nselect 1;`);
      await ctx.page.keyboard.press('ControlOrMeta+Shift+l');
      await expect(ctx.page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'statement-log',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      await runSql(ctx, 'select * from shop.orders;');
      await ctx.page.keyboard.press('ControlOrMeta+j');
      await ctx.page.waitForTimeout(300);
    },
  },
  {
    name: 'migrations',
    prepare: async (ctx) => {
      await connect(ctx, /^local postgres,/);
      await expand(treeItem(ctx.page, /^public$/));
      await expand(treeItem(ctx.page, /^Tables? \(/).first());
      await contextMenu(
        ctx,
        treeItem(ctx.page, /^__EFMigrationsHistory$/),
        'explorer.menu.migrations',
      );
      await ctx.page.waitForTimeout(300);
    },
  },
];

for (const { locale, ...size } of LAYOUTS) {
  test.describe(`${locale} ${String(size.width)}×${String(size.height)}`, () => {
    test.use({
      viewport: size,
      locale: locale === 'fr' ? 'fr-FR' : 'en-US',
      colorScheme: THEME,
    });

    for (const screen of SCREENS) {
      test(screen.name, async ({ page }) => {
        const tr = (key: string) => {
          const text = catalogs[locale][key];
          if (text === undefined) throw new Error(`no message ${key}`);
          return text;
        };
        await page.goto('/');
        await expect(tree(page)).toBeVisible();
        await screen.prepare({ page, tr });
        await page.evaluate(() => document.fonts.ready);
        const slug = `${screen.name}-${locale}-${String(size.width)}${THEME === 'light' ? '-paper' : ''}`;
        await page.screenshot({ path: test.info().outputPath(`overflow-${slug}.png`) });
        const found = await findOverflows(page);
        await screen.check?.({ page, tr });
        if (AUDIT) {
          if (found.length > 0) {
            console.log(
              `\n## ${slug}\n${found.map((f) => `  ${f.kind} +${String(f.by)}px  ${f.element}  «${f.text}»`).join('\n')}`,
            );
          }
        } else {
          expect(found, `what overflows on ${slug}`).toEqual([]);
        }
      });
    }
  });
}
