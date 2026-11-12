import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Elasticsearch on the mock backend (M4-7): the connection form (one URL, the kind of
 * authentication), the explorer (indices, data streams, aliases, templates, an index's fields
 * and settings), an index tab in its grid and documents views with a query string, a sort and
 * the count as the server gives it, the console (hits, an aggregation's JSON tree, a `_cat`
 * text answer, an ES|QL table, an error placed in the text), a dangerous request's
 * confirmation and a read-only refusal. Captures in both themes.
 */

interface MockControls {
  setLatency: (ms: number) => void;
  setMetaLatency: (ms: number) => void;
}
type MockWindow = Window & { __yadbeMock?: MockControls };

const THEMES = [
  { name: 'graphite', colorScheme: 'dark' },
  { name: 'paper', colorScheme: 'light' },
] as const;

async function capture(page: Page, theme: string, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: test.info().outputPath(`search-${state}-${theme}.png`),
    animations: 'disabled',
  });
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Connections' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const SEARCH = /^search · logs,/;

async function expand(row: Locator) {
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) === 'false') {
    await row.locator('span').first().click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

async function connect(page: Page) {
  await item(page, SEARCH).click();
  await item(page, SEARCH).locator('span').first().click();
  await expect(item(page, SEARCH)).toHaveAccessibleName(/Connected/);
  // A search connection opens on its indices.
  await expect(item(page, /^orders$/)).toBeVisible();
}

const editor = (page: Page) => page.getByTestId('search-console-editor').locator('.cm-content');

async function openConsole(page: Page, text: string) {
  await connect(page);
  await item(page, SEARCH).dblclick();
  await expect(editor(page)).toBeVisible();
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

async function setReadOnly(page: Page) {
  await item(page, SEARCH).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  const form = page.getByRole('dialog', { name: 'Edit connection' });
  await form.getByRole('switch', { name: /Read-only/ }).click();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
}

for (const { name, colorScheme } of THEMES) {
  test.describe(`${name} theme`, () => {
    test.use({ colorScheme, locale: 'en-US', viewport: { width: 1400, height: 900 } });

    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', name);
      await expect(item(page, SEARCH)).toBeVisible();
      await page.evaluate(() => {
        (window as MockWindow).__yadbeMock?.setMetaLatency(10);
        (window as MockWindow).__yadbeMock?.setLatency(20);
      });
    });

    test('the connection form takes one URL and the kind of authentication', async ({ page }) => {
      await page.getByRole('button', { name: 'New connection' }).first().click();
      const form = page.getByRole('dialog', { name: 'New connection' });
      await form.getByRole('radio', { name: 'Elasticsearch / OpenSearch' }).click();
      const url = form.locator('[data-field="url"]');
      await expect(url).toHaveValue('http://localhost:9200');
      await url.fill('https://search.example.com:9243/es');
      // HTTPS brings the certificate checks.
      await expect(form.locator('[data-field="caCertPath"]')).toBeVisible();
      await form.locator('[data-field="searchAuth"]').selectOption('apiKey');
      await expect(form.getByLabel('API key', { exact: true })).toBeVisible();
      await expect(form.locator('[data-field="username"]')).toHaveCount(0);
      await capture(page, name, 'form');
      // A URL with credentials fills the form; its password stays in the backend.
      await url.focus();
      await page.evaluate(() => {
        const input = document.activeElement as HTMLInputElement;
        const data = new DataTransfer();
        data.setData('text', 'https://elastic:s3cret@es.internal:9200/');
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
      });
      await expect(url).toHaveValue('https://es.internal:9200');
      await expect(form.locator('[data-field="searchAuth"]')).toHaveValue('basic');
      await expect(form.locator('[data-field="username"]')).toHaveValue('elastic');
      await expect(form.locator('[data-field="password"]')).toHaveValue('');
      await url.fill('not a url');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form.getByText('Write an http:// or https:// URL with a host.')).toBeVisible();
    });

    test('the explorer lists indices, data streams, aliases, templates and fields', async ({
      page,
    }) => {
      await connect(page);
      await expect(item(page, /^logs-app-2025\.11$/)).toBeVisible();
      // System indices only with the system objects.
      await expect(item(page, /^\.kibana_1$/)).toHaveCount(0);
      await expand(item(page, /^Data streams/));
      await expect(item(page, /^logs-web$/)).toBeVisible();
      await expand(item(page, /^Aliases/));
      await expect(item(page, /^orders-current$/)).toBeVisible();
      await expand(item(page, /^Index templates/));
      await expand(item(page, /^orders$/).first());
      await expand(item(page, /^Fields/).first());
      await expect(item(page, /^customer\.email$/)).toBeVisible();
      await expect(item(page, /^notes\.keyword$/)).toBeVisible();
      await capture(page, name, 'explorer');
    });

    test('an index tab pages its documents in a grid and as documents', async ({ page }) => {
      await connect(page);
      await item(page, /^orders$/).dblclick();
      await expect(page.getByTestId('index-tab')).toBeVisible();
      await expect(page.getByTestId('index-range')).toHaveText('1–100');
      await expect(page.getByTestId('index-count')).toHaveText('1,240 documents');
      await expect(page.getByTestId('index-paging')).toContainText('Point in time');
      const grid = page.getByRole('grid', { name: /^Documents of orders/ });
      await expect(grid.getByRole('columnheader', { name: /customer\.name/ })).toBeVisible();
      await capture(page, name, 'index-grid');
      // A query string, a sort on a sortable field.
      await page.locator('[data-field="query"]').fill('status:paid');
      await page.locator('[data-field="sort"]').selectOption('total');
      await page.getByRole('button', { name: 'Ascending: click for descending' }).click();
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page.getByTestId('index-count')).toHaveText('310 documents');
      await page.getByRole('button', { name: 'Next page' }).click();
      await expect(page.getByTestId('index-range')).toHaveText('101–200');
      await page.getByRole('radio', { name: 'Documents' }).click();
      await expect(page.getByRole('tree', { name: /^Documents of orders/ })).toBeVisible();
      await capture(page, name, 'index-documents');
      // The large index counts up to 10 000 at once; the exact count on request.
      await item(page, /^logs-app-2025\.11$/).dblclick();
      await expect(page.getByTestId('index-count')).toHaveText('≥ 10,000 documents');
      await page.getByRole('button', { name: 'Exact count' }).click();
      await expect(page.getByTestId('index-count')).toHaveText('25,000 documents');
    });

    test('the console shows hits, JSON answers, text and tables', async ({ page }) => {
      await openConsole(
        page,
        'GET _cat/indices?v\n\nPOST /orders/_search\n{\n  "size": 3,\n  "aggs": { "by_status": { "terms": { "field": "status" } } }\n}\n\nPOST /_query\n{ "query": "FROM orders | LIMIT 5" }\n',
      );
      await page.getByRole('button', { name: 'Run all' }).click();
      const answers = page.getByRole('tablist', { name: 'Answers of the last run' });
      await expect(answers.getByRole('tab')).toHaveCount(3);
      // The last answer shows first: the ES|QL table.
      await expect(page.getByRole('grid', { name: /^Rows of POST \/_query/ })).toBeVisible();
      await capture(page, name, 'console-table');
      await answers.getByRole('tab', { name: /\/orders\/_search/ }).click();
      await expect(page.getByRole('grid', { name: /^Hits of POST/ })).toBeVisible();
      await capture(page, name, 'console-hits');
      await page.getByRole('radio', { name: 'JSON' }).click();
      await expect(page.getByRole('tree', { name: /^Answer to POST/ })).toBeVisible();
      await capture(page, name, 'console-json');
      await answers.getByRole('tab', { name: /_cat\/indices/ }).click();
      await expect(page.getByTestId('search-response-text')).toContainText('orders');
      await capture(page, name, 'console-text');
    });

    test('an error points at its line and the cursor runs one request', async ({ page }) => {
      await openConsole(page, 'GET /orders/_count\n\nPOST /orders/_search\n{\n  "size": 1,\n}\n');
      // The cursor is on the last line: only that request runs.
      await page.keyboard.press('ControlOrMeta+Enter');
      const answers = page.getByRole('tablist', { name: 'Answers of the last run' });
      await expect(answers.getByRole('tab')).toHaveCount(1);
      await expect(page.getByTestId('search-response')).toContainText(
        'The server rejected the request at line 5',
      );
      await capture(page, name, 'console-error');
    });

    test('dangerous requests are confirmed, read-only refuses writes', async ({ page }) => {
      await openConsole(page, 'DELETE /orders\n');
      await page.keyboard.press('ControlOrMeta+Enter');
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
      await expect(dialog.getByText('Send a dangerous request?')).toBeVisible();
      await expect(dialog.getByText(/1,240 documents for good/)).toBeVisible();
      await capture(page, name, 'danger');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('tablist', { name: 'Answers of the last run' })).toHaveCount(0);
      await setReadOnly(page);
      await editor(page).click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText('PUT /new-index\n');
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(page.getByTestId('search-response')).toContainText(
        'This connection is read-only',
      );
      await capture(page, name, 'read-only');
    });
  });
}
