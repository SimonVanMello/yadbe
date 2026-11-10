#!/usr/bin/env node
// P-01 (spec §3): cold start until the window is interactive, target < 800 ms.
//
// Usage (release build first: `pnpm tauri build --no-bundle`):
//   node scripts/measure-startup.mjs [--runs 10] [--binary path] [--drop-caches]
//   Linux without a display: xvfb-run -a node scripts/measure-startup.mjs
//
// Each run starts the release binary with YADBE_PERF_PROBE=1: the app prints a line when its
// main window becomes visible (the frontend shows it once preferences, layout and the restored
// tabs are rendered, see src/app/Shell.tsx) and quits. Measured from just before spawning the
// process, so executable loading, webview creation, JS boot and restoration are all included.
//
// Scenarios: `welcome` (empty config, first launch) and `restore` (a saved SQLite connection and
// three restored query tabs). `--drop-caches` (Linux, root) empties the page cache before each
// run for a true cold start; otherwise the first run is the coldest and the others are warm.
// Needs Node 22.5+ (`node:sqlite`, to seed the restore scenario).

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_MS = 800;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const runs = Number(option('runs', '10'));
const dropCaches = process.argv.includes('--drop-caches');
const binary = resolve(
  option(
    'binary',
    join(ROOT, 'src-tauri/target/release', process.platform === 'win32' ? 'yadbe.exe' : 'yadbe'),
  ),
);

if (!existsSync(binary)) {
  console.error(`No release binary at ${binary}. Run \`pnpm tauri build --no-bundle\` first.`);
  process.exit(1);
}

// Loaded lazily: `node:sqlite` prints an experimental warning on Node 22.
const { DatabaseSync } = await import('node:sqlite');

/** A SQLite connection to `dbFile` and three query tabs bound to it, in a launched config. */
function seedRestore(configDir, dbFile) {
  const user = new DatabaseSync(dbFile);
  user.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)');
  user.close();
  const store = new DatabaseSync(join(configDir, 'yadbe.db'));
  const id = randomUUID();
  // Unix seconds; a JS number would be bound as REAL, the store reads integers.
  const now = BigInt(Math.floor(Date.now() / 1000));
  store
    .prepare(
      `INSERT INTO connections (id, name, engine, position, file_path, auth, tls_mode,
         created_at, updated_at) VALUES (?, 'fixture.sqlite', 'sqlite', 0, ?, 'none', 'prefer', ?, ?)`,
    )
    .run(id, dbFile, now, now);
  store.exec('DELETE FROM tabs');
  const tab = store.prepare(
    `INSERT INTO tabs (position, id, kind, title, connection_id, content, ui_state)
       VALUES (?, ?, 'query', ?, ?, '', ?)`,
  );
  for (const ordinal of [1, 2, 3]) {
    tab.run(
      ordinal - 1,
      `tab-${String(ordinal)}`,
      `Query ${String(ordinal)}`,
      id,
      `{"ordinal":${String(ordinal)}}`,
    );
  }
  store.close();
}

function tryDropCaches() {
  try {
    execFileSync('sync');
    writeFileSync('/proc/sys/vm/drop_caches', '3');
    return true;
  } catch {
    return false;
  }
}

/** Starts the app once; resolves with the time until its window became visible. */
function launch(configDir) {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const child = spawn(binary, [], {
      env: { ...process.env, YADBE_PERF_PROBE: '1', YADBE_CONFIG_DIR: configDir, RUST_LOG: 'warn' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let visibleAfter = null;
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (visibleAfter === null && output.includes('yadbe-perf window-visible')) {
        visibleAfter = performance.now() - started;
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the app did not show its window within 30 s'));
    }, 30_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const inProcess = /since_run_ms=(\d+)/.exec(output)?.[1];
      if (visibleAfter === null)
        reject(new Error(`the app exited (${String(code)}) before showing its window`));
      else resolvePromise({ totalMs: visibleAfter, inProcessMs: Number(inProcess) });
    });
  });
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n) => Math.round(n);
  return {
    first: round(values[0]),
    min: round(sorted[0]),
    median: round(sorted[Math.floor(sorted.length / 2)]),
    max: round(sorted.at(-1)),
  };
}

const work = mkdtempSync(join(tmpdir(), 'yadbe-p01-'));
const results = {};
try {
  // Restore scenario: a first launch creates the store, then it is seeded.
  const restoreConfig = join(work, 'config-restore');
  mkdirSync(restoreConfig);
  await launch(restoreConfig);
  seedRestore(restoreConfig, join(work, 'fixture.sqlite'));

  for (const scenario of ['welcome', 'restore']) {
    const totals = [];
    const inProcess = [];
    let dropped = false;
    for (let i = 0; i < runs; i++) {
      if (dropCaches) dropped = tryDropCaches();
      const configDir =
        scenario === 'welcome' ? mkdtempSync(join(work, 'config-welcome-')) : restoreConfig;
      const result = await launch(configDir);
      totals.push(result.totalMs);
      inProcess.push(result.inProcessMs);
    }
    results[scenario] = {
      spawnToVisibleMs: stats(totals),
      inProcessMs: stats(inProcess),
      cachesDropped: dropped,
    };
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const report = { target: TARGET_MS, runs, binary, platform: process.platform, results };
console.log(JSON.stringify(report, null, 2));
const out = join(ROOT, 'test-results/perf');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'p01.json'), JSON.stringify(report, null, 2));
const worst = Math.max(...Object.values(results).map((r) => r.spawnToVisibleMs.median));
console.log(
  `P-01 median ${String(worst)} ms (target < ${String(TARGET_MS)} ms): ${worst < TARGET_MS ? 'OK' : 'MISSED'}`,
);
