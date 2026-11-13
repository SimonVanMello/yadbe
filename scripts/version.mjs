// The app version lives in package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and
// src-tauri/Cargo.lock. `check` fails when they disagree, or differ from a `vX.Y.Z` tag; `set`
// rewrites all four. See docs/RELEASING.md.
// Usage: node scripts/version.mjs check [vX.Y.Z] | set <x.y.z>
// YADBE_VERSION_ROOT points it at another checkout (its tests).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.YADBE_VERSION_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const files = {
  package: join(root, 'package.json'),
  tauri: join(root, 'src-tauri/tauri.conf.json'),
  cargo: join(root, 'src-tauri/Cargo.toml'),
  lock: join(root, 'src-tauri/Cargo.lock'),
};
// No pre-release suffix: the Windows MSI bundler only accepts numeric versions.
const SEMVER = /^\d+\.\d+\.\d+$/;
// First `version` of the [package] table, and the `yadbe` entry of the lockfile.
const CARGO_VERSION = /^(\[package\][^[]*?^version = ")([^"]+)(")/ms;
const LOCK_VERSION = /^(name = "yadbe"\nversion = ")([^"]+)(")/m;

function read(path) {
  return readFileSync(path, 'utf8');
}

function versions() {
  return {
    'package.json': JSON.parse(read(files.package)).version,
    'src-tauri/tauri.conf.json': JSON.parse(read(files.tauri)).version,
    'src-tauri/Cargo.toml': read(files.cargo).match(CARGO_VERSION)?.[2],
    'src-tauri/Cargo.lock': read(files.lock).match(LOCK_VERSION)?.[2],
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function check(tag) {
  const found = versions();
  const distinct = new Set(Object.values(found));
  if (distinct.size !== 1 || distinct.has(undefined)) {
    fail(
      `Versions disagree:\n${Object.entries(found)
        .map(([file, version]) => `  ${file}: ${version ?? 'not found'}`)
        .join('\n')}\nRun \`pnpm release:version <x.y.z>\`.`,
    );
  }
  const [version] = distinct;
  if (!SEMVER.test(version)) fail(`Version ${version} is not x.y.z.`);
  if (tag && tag !== `v${version}`) {
    fail(`Tag ${tag} does not match version ${version}: expected v${version}.`);
  }
  console.log(`version=${version}`);
}

function replaceJsonVersion(path, version) {
  const text = read(path);
  const pattern = /^(\s*"version":\s*")[^"]+(")/m;
  if (!pattern.test(text)) fail(`No version found in ${path}`);
  writeFileSync(path, text.replace(pattern, `$1${version}$2`));
}

function replaceVersion(path, pattern, version) {
  const text = read(path);
  if (!pattern.test(text)) fail(`No version found in ${path}`);
  writeFileSync(path, text.replace(pattern, `$1${version}$3`));
}

function set(version) {
  if (!version || !SEMVER.test(version)) fail('Usage: pnpm release:version <x.y.z>');
  replaceJsonVersion(files.package, version);
  replaceJsonVersion(files.tauri, version);
  replaceVersion(files.cargo, CARGO_VERSION, version);
  replaceVersion(files.lock, LOCK_VERSION, version);
  check();
}

const [command, arg] = process.argv.slice(2);
if (command === 'check') check(arg);
else if (command === 'set') set(arg);
else fail('Usage: node scripts/version.mjs check [vX.Y.Z] | set <x.y.z>');
