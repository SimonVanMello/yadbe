// @vitest-environment node
// The release scripts the workflows call (docs/RELEASING.md), run as the workflows run them.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function run(script, args, env = {}) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'yadbe-release-'));
}

/** A copy of the four files that hold the version. */
function versionedCopy() {
  const dir = tempDir();
  mkdirSync(join(dir, 'src-tauri'));
  for (const file of [
    'package.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
  ]) {
    copyFileSync(join(root, file), join(dir, file));
  }
  return dir;
}

describe('version.mjs', () => {
  it('finds the same version in the four files of the repository', () => {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const result = run('version.mjs', ['check']);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(`version=${version}`);
    expect(run('version.mjs', ['check', `v${version}`]).status).toBe(0);
    expect(run('version.mjs', ['check', 'v99.0.0']).status).toBe(1);
  });

  it('sets the version everywhere, and only plain x.y.z', () => {
    const dir = versionedCopy();
    const env = { YADBE_VERSION_ROOT: dir };
    expect(run('version.mjs', ['set', '1.2.3-beta'], env).status).toBe(1);
    const result = run('version.mjs', ['set', '1.2.3'], env);
    expect(result.stdout.trim()).toBe('version=1.2.3');
    expect(run('version.mjs', ['check', 'v1.2.3'], env).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'src-tauri/tauri.conf.json'), 'utf8')).version).toBe(
      '1.2.3',
    );
    expect(readFileSync(join(dir, 'src-tauri/Cargo.lock'), 'utf8')).toContain(
      'name = "yadbe"\nversion = "1.2.3"',
    );
    // Only yadbe's entry of the lockfile, not a dependency that happens to share its version.
    const before = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8');
    const after = readFileSync(join(dir, 'src-tauri/Cargo.lock'), 'utf8');
    expect(after.length - before.length).toBe(
      '1.2.3'.length - JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.length,
    );
  });

  it('refuses files that disagree', () => {
    const dir = versionedCopy();
    const cargo = join(dir, 'src-tauri/Cargo.toml');
    writeFileSync(
      cargo,
      readFileSync(cargo, 'utf8').replace(/^version = ".*"$/m, 'version = "9.9.9"'),
    );
    const result = run('version.mjs', ['check'], { YADBE_VERSION_ROOT: dir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src-tauri/Cargo.toml: 9.9.9');
  });
});

describe('updater-manifest.mjs', () => {
  const FILES = [
    'yadbe_1.2.3_aarch64.app.tar.gz',
    'yadbe_1.2.3_x64.app.tar.gz',
    'yadbe_1.2.3_amd64.AppImage',
    'yadbe_1.2.3_x64-setup.exe',
    'yadbe_1.2.3_x64_en-US.msi',
  ];

  function bundles(files) {
    const dir = tempDir();
    for (const file of files) {
      writeFileSync(join(dir, file), 'bundle');
      writeFileSync(join(dir, `${file}.sig`), `signature of ${file}\n`);
    }
    return dir;
  }

  it('lists every updater target with its signature and address', () => {
    const dir = bundles(FILES);
    const result = run('updater-manifest.mjs', ['1.2.3', dir, 'SimonVanMello/yadbe']);
    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.notes).toBe('https://github.com/SimonVanMello/yadbe/releases/tag/v1.2.3');
    expect(manifest.pub_date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'linux-x86_64',
      'linux-x86_64-appimage',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ]);
    expect(manifest.platforms['linux-x86_64']).toEqual({
      signature: 'signature of yadbe_1.2.3_amd64.AppImage',
      url: 'https://github.com/SimonVanMello/yadbe/releases/download/v1.2.3/yadbe_1.2.3_amd64.AppImage',
    });
  });

  it('writes no manifest that leaves a platform out', () => {
    const dir = bundles(FILES.slice(1));
    const result = run('updater-manifest.mjs', ['1.2.3', dir, 'SimonVanMello/yadbe']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('yadbe_1.2.3_aarch64.app.tar.gz');
    expect(existsSync(join(dir, 'latest.json'))).toBe(false);
  });
});

describe('homebrew.mjs', () => {
  it('writes the cask of both .dmg files, left to the updater', () => {
    const dir = tempDir();
    expect(run('homebrew.mjs', ['1.2.3', SHA_A, SHA_B, dir]).status).toBe(0);
    const cask = readFileSync(join(dir, 'Casks/yadbe.rb'), 'utf8');
    expect(cask).toContain('cask "yadbe" do\n  version "1.2.3"');
    expect(cask).toContain(`sha256 "${SHA_A}"`);
    expect(cask).toContain(
      'url "https://github.com/SimonVanMello/yadbe/releases/download/v#{version}/yadbe_#{version}_x64.dmg"',
    );
    expect(cask).toContain('auto_updates true');
    expect(cask).toContain('app "yadbe.app"');
    expect(cask).toContain('~/Library/Application Support/dev.tropico.yadbe');
    expect(run('homebrew.mjs', ['1.2.3', 'nothex', SHA_B, dir]).status).toBe(1);
  });
});

describe('aur.mjs', () => {
  it('writes the PKGBUILD and the .SRCINFO of yadbe-bin', () => {
    const dir = tempDir();
    expect(run('aur.mjs', ['1.2.3', SHA_A, dir, '2']).status).toBe(0);
    const pkgbuild = readFileSync(join(dir, 'PKGBUILD'), 'utf8');
    expect(pkgbuild).toContain('pkgname=yadbe-bin\npkgver=1.2.3\npkgrel=2\n');
    expect(pkgbuild).toContain("license=('GPL-3.0-or-later')");
    expect(pkgbuild).toContain(
      'source=("yadbe-${pkgver}.deb::https://github.com/SimonVanMello/yadbe/releases/download/v${pkgver}/yadbe_${pkgver}_amd64.deb")',
    );
    const srcinfo = readFileSync(join(dir, '.SRCINFO'), 'utf8');
    // makepkg --printsrcinfo's order, which the workflow compares against.
    const fields = srcinfo
      .split('\n')
      .filter((line) => line.startsWith('\t'))
      .map((line) => line.trim().split(' = ')[0]);
    expect([...new Set(fields)]).toEqual([
      'pkgdesc',
      'pkgver',
      'pkgrel',
      'url',
      'arch',
      'license',
      'depends',
      'optdepends',
      'provides',
      'conflicts',
      'options',
      'source',
      'sha256sums',
    ]);
    expect(srcinfo).toContain(
      '\tsource = yadbe-1.2.3.deb::https://github.com/SimonVanMello/yadbe/releases/download/v1.2.3/yadbe_1.2.3_amd64.deb\n',
    );
    expect(run('aur.mjs', ['1.2.3', SHA_A, dir, '0']).status).toBe(1);
  });
});

describe('updater-key.mjs', () => {
  function config(pubkey, requireSignedVersion = true) {
    const dir = tempDir();
    const path = join(dir, 'tauri.conf.json');
    writeFileSync(path, JSON.stringify({ plugins: { updater: { pubkey, requireSignedVersion } } }));
    return path;
  }

  /** A public key in the format of `tauri signer generate` (random bytes, no private half). */
  function publicKeyFile(keyId) {
    const key = Buffer.concat([Buffer.from('Ed'), keyId, randomBytes(32)]);
    const id = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
    const file = `untrusted comment: minisign public key: ${id}\n${key.toString('base64')}\n`;
    return { pubkey: Buffer.from(file).toString('base64'), id };
  }

  it('refuses the empty key the repository ships with', () => {
    const result = run('updater-key.mjs', [join(root, 'src-tauri/tauri.conf.json')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('plugins.updater.pubkey is empty');
  });

  it('accepts a minisign public key and names it', () => {
    const { pubkey, id } = publicKeyFile(randomBytes(8));
    const result = run('updater-key.mjs', [config(pubkey)]);
    expect(result.stdout.trim()).toBe(`updater public key ${id}`);
  });

  it('refuses something else, or a configuration that accepts unbound signatures', () => {
    expect(run('updater-key.mjs', [config(Buffer.from('hello').toString('base64'))]).status).toBe(
      1,
    );
    const { pubkey } = publicKeyFile(randomBytes(8));
    expect(run('updater-key.mjs', [config(pubkey, false)]).status).toBe(1);
  });
});
