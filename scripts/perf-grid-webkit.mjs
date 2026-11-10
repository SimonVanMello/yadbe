#!/usr/bin/env node
// P-04 (spec §3) in the real app on WebKitGTK: scrolling a 100 000 × 50 PostgreSQL result at a
// sustained 60 fps, no frame over 32 ms, on both axes. `pnpm perf:grid` measures the same
// movements on Chromium with the mock backend; this one goes through the backend, the IPC and
// WebKitGTK.
//
// Usage (Linux; a built app first: `pnpm tauri build --debug --no-bundle`):
//   Xvfb :99 &   DISPLAY=:99 YADBE_CONFIG_DIR=$(mktemp -d) tauri-driver &
//   YADBE_TEST_PG_URL=postgres://user:pw@localhost:5432/db node scripts/perf-grid-webkit.mjs \
//     [--binary src-tauri/target/debug/yadbe] [--seconds 5]
//
// The script creates (once) a `p04_grid` table of 100 000 rows × 50 columns of mixed kinds in
// that database, opens a query tab on it, runs `select * from p04_grid`, enlarges the results
// area, then moves the grid from a rAF loop and records every frame interval: a vertical flick
// down and up (6 000 px/s) and sweeps across the columns (3 000 px/s).
//
// Under Xvfb, WebKitGTK composites with software GL (llvmpipe), which alone caps an empty
// scrolling page near 20 fps: start tauri-driver with WEBKIT_DISABLE_COMPOSITING_MODE=1 to
// measure the grid rather than the container's GL. A machine with a GPU needs neither.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const DRIVER = option('driver', 'http://127.0.0.1:4444');
const BINARY = resolve(option('binary', join(ROOT, 'src-tauri/target/debug/yadbe')));
const SECONDS = Number(option('seconds', '5'));
const PG_URL = process.env.YADBE_TEST_PG_URL;
if (!PG_URL) {
  console.error('Set YADBE_TEST_PG_URL (postgres://user:password@host:port/database).');
  process.exit(2);
}
const pg = new URL(PG_URL);
const TARGET_FPS = 60;
const LONG_FRAME_MS = 32;

const KINDS = [
  'g * 7 % 1000',
  "'text value ' || (g % 977)",
  '(g * 1.25)::numeric(12, 2)',
  "timestamptz '2026-01-01' + g * interval '1 minute'",
  'g % 2 = 0',
];
const COLUMNS = [
  'g as id',
  ...Array.from(
    { length: 49 },
    (_, i) => `${KINDS[(i + 1) % 5]} as col_${String(i + 1).padStart(2, '0')}`,
  ),
];
const SETUP = `create table if not exists p04_grid as select ${COLUMNS.join(', ')} from generate_series(1, 100000) g`;

async function wd(method, path, body) {
  const response = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (json.value?.error) throw new Error(`${path}: ${json.value.error}: ${json.value.message}`);
  return json.value;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const { sessionId } = await wd('POST', '/session', {
  capabilities: { alwaysMatch: { 'tauri:options': { application: BINARY } } },
});
const at = (path) => `/session/${sessionId}${path}`;
const run = (script, args = []) => wd('POST', at('/execute/sync'), { script, args });
const runAsync = (script, args = []) => wd('POST', at('/execute/async'), { script, args });
async function until(script, what, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await run(script).catch(() => null);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function typeAndRun(sql) {
  const found = await wd('POST', at('/element'), { using: 'css selector', value: '.cm-content' });
  const editor = Object.values(found)[0];
  await wd('POST', at(`/element/${editor}/click`), {});
  // Ctrl+A, Backspace: the editor starts empty.
  await wd('POST', at('/actions'), {
    actions: [
      {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: '\uE009' },
          { type: 'keyDown', value: 'a' },
          { type: 'keyUp', value: 'a' },
          { type: 'keyUp', value: '\uE009' },
          { type: 'keyDown', value: '\uE003' },
          { type: 'keyUp', value: '\uE003' },
        ],
      },
    ],
  });
  await wd('POST', at(`/element/${editor}/value`), { text: sql });
  await sleep(200);
  // Ctrl+Enter runs the editor's text.
  await wd('POST', at('/actions'), {
    actions: [
      {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: '' },
          { type: 'keyDown', value: '' },
          { type: 'keyUp', value: '' },
          { type: 'keyUp', value: '' },
        ],
      },
    ],
  });
}

/** Moves the grid for `duration` ms from a rAF loop; resolves with the frame intervals. */
const MOVE = `
  const [movement, duration, done] = arguments;
  const el = document.querySelector('[role=grid]');
  el.scrollTop = movement === 'horizontal' ? (el.scrollHeight - el.clientHeight) / 3 : 0;
  el.scrollLeft = 0;
  setTimeout(() => {
    const intervals = [];
    const maxTop = el.scrollHeight - el.clientHeight;
    const maxLeft = el.scrollWidth - el.clientWidth;
    const start = performance.now();
    let last = start;
    let loading = 0;
    const tick = (now) => {
      intervals.push(now - last);
      last = now;
      const elapsed = now - start;
      if (movement === 'vertical') {
        const half = duration / 2;
        const travel = Math.min(maxTop, 6000 * half / 1000);
        el.scrollTop = travel * Math.max(0, elapsed < half ? elapsed / half : 2 - elapsed / half);
      } else {
        const period = 2 * maxLeft;
        const x = (elapsed / 1000 * 3000) % period;
        el.scrollLeft = x < maxLeft ? x : period - x;
      }
      if (el.querySelector('[data-loading]')) loading++;
      if (elapsed < duration) requestAnimationFrame(tick);
      else done({ intervals: intervals.slice(1), loading, size: [el.clientWidth, el.clientHeight] });
    };
    requestAnimationFrame(tick);
  }, 1500);
`;

const lines = [];
let failed = false;
try {
  await wd('POST', at('/timeouts'), { script: 120_000 });
  await wd('POST', at('/window/rect'), { width: 1280, height: 860 }).catch(() => undefined);
  await until("return !!document.querySelector('[role=tree]')", 'the window');
  const userAgent = await run('return navigator.userAgent');
  // A connection to the database, opened before the sidebar reads the list (test tooling: the
  // app itself only talks to the backend through src/ipc).
  const opened = await runAsync(
    `
    const [definition, password, done] = arguments;
    const invoke = window.__TAURI_INTERNALS__.invoke;
    (async () => {
      const list = await invoke('list_connections');
      const conn = list.find((c) => c.definition.name === definition.name)
        ?? await invoke('create_connection', { definition });
      await invoke('connect', { connectionId: conn.id, password: { kind: 'value', value: password } });
      return 'ok';
    })().then(done, (error) => done('failed: ' + JSON.stringify(error)));
  `,
    [
      {
        name: 'p04 grid',
        engine: 'postgres',
        host: pg.hostname,
        port: Number(pg.port || 5432),
        database: decodeURIComponent(pg.pathname.slice(1)),
        username: decodeURIComponent(pg.username),
        filePath: '',
        auth: 'password',
        tlsMode: 'prefer',
        caCertPath: null,
        connectTimeoutSecs: null,
        options: [],
        groupId: null,
        environment: { kind: 'dev', label: null, color: null },
        favorite: false,
        readOnly: false,
        rememberPassword: false,
      },
      decodeURIComponent(pg.password),
    ],
  );
  if (opened !== 'ok') throw new Error(`could not connect: ${opened}`);
  await run('location.reload()');
  await sleep(1000);
  await until(
    "return [...document.querySelectorAll('[role=treeitem]')].some((e) => /^p04 grid,/.test(e.getAttribute('aria-label') ?? ''))",
    'the connection in the sidebar',
  );
  await run(
    "[...document.querySelectorAll('[role=treeitem]')].find((e) => /^p04 grid,/.test(e.getAttribute('aria-label') ?? '')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))",
  );
  await until("return !!document.querySelector('.cm-content')", 'the editor');
  await typeAndRun(SETUP);
  const setup = await until(
    "const text = document.querySelector('[data-testid=run-status]')?.textContent ?? ''; return /^Failed|^Échec/.test(text) ? 'failed' : /statement ·|instruction ·/.test(text) ? 'ok' : null",
    'the table',
    600_000,
  );
  if (setup !== 'ok') throw new Error('creating p04_grid failed: see the Messages tab');
  await typeAndRun('select * from p04_grid');
  const started = Date.now();
  await until(
    "const g = document.querySelector('[role=grid]'); return g?.getAttribute('aria-rowcount') === '100001' && !g.querySelector('[data-loading]')",
    'the 100 000 rows',
  );
  lines.push(`result complete and drawn after ${String(Date.now() - started)} ms`);
  // A results area of about the spec's size: the editor shrunk to a few lines.
  await run(`
    const handle = [...document.querySelectorAll('[role=separator]')]
      .find((e) => /results|résultats/i.test(e.getAttribute('aria-label') ?? ''));
    for (let i = 0; i < 30; i++) handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  `);
  await sleep(1500);
  for (const movement of ['vertical', 'horizontal', 'vertical', 'horizontal']) {
    const result = await runAsync(MOVE, [movement, SECONDS * 1000]);
    const sorted = [...result.intervals].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    const round = (n) => Math.round(n * 10) / 10;
    const over = sorted.filter((d) => d > LONG_FRAME_MS).length;
    if (1000 / q(0.5) < TARGET_FPS * 0.95 || over > 0) failed = true;
    lines.push(
      `${movement.padEnd(10)} grid ${result.size.join('×')}: ${String(sorted.length)} frames, median ${String(round(q(0.5)))} ms (${String(round(1000 / q(0.5)))} fps), ` +
        `p95 ${String(round(q(0.95)))} ms, p99 ${String(round(q(0.99)))} ms, max ${String(round(sorted.at(-1) ?? 0))} ms, ` +
        `>20 ms: ${String(sorted.filter((d) => d > 20).length)}, >${String(LONG_FRAME_MS)} ms: ${String(over)}, frames with loading rows: ${String(result.loading)}`,
    );
  }
  const text = `P-04 in the real app (${userAgent}), ${BINARY}, ${String(SECONDS)} s per movement\n${lines.join('\n')}\n`;
  console.log(text);
  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  writeFileSync(join(ROOT, 'test-results', 'p04-webkit.txt'), text);
} finally {
  await wd('DELETE', at('')).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
