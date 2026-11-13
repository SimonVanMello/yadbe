// Writes `latest.json`, the update manifest the app reads (src-tauri/src/updates.rs) and the
// Tauri updater installs from, out of the bundles of a release and their `.sig` files.
// Usage: node scripts/updater-manifest.mjs <x.y.z> <bundles dir> <owner/repo>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, dir, repo] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !dir || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
  console.error('Usage: node scripts/updater-manifest.mjs <x.y.z> <bundles dir> <owner/repo>');
  process.exit(1);
}

// Updater targets: `{os}-{arch}-{installer}` is looked up first, then `{os}-{arch}`. A `.deb` or
// `.rpm` install finds no target of its own and falls back to the AppImage's `linux-x86_64`;
// the app never hands it to the updater (it is upgraded by its package manager).
const BUNDLES = [
  {
    file: `yadbe_${version}_aarch64.app.tar.gz`,
    targets: ['darwin-aarch64', 'darwin-aarch64-app'],
  },
  { file: `yadbe_${version}_x64.app.tar.gz`, targets: ['darwin-x86_64', 'darwin-x86_64-app'] },
  { file: `yadbe_${version}_amd64.AppImage`, targets: ['linux-x86_64', 'linux-x86_64-appimage'] },
  { file: `yadbe_${version}_x64-setup.exe`, targets: ['windows-x86_64', 'windows-x86_64-nsis'] },
  { file: `yadbe_${version}_x64_en-US.msi`, targets: ['windows-x86_64-msi'] },
];

const platforms = {};
const missing = [];
for (const { file, targets } of BUNDLES) {
  const signature = join(dir, `${file}.sig`);
  if (!existsSync(join(dir, file)) || !existsSync(signature)) {
    missing.push(file);
    continue;
  }
  const entry = {
    signature: readFileSync(signature, 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(file)}`,
  };
  for (const target of targets) platforms[target] = entry;
}
if (missing.length > 0) {
  // A platform missing from the manifest could never update again: no partial manifest.
  console.error(`Missing bundle or signature: ${missing.join(', ')}`);
  process.exit(1);
}

const manifest = {
  version,
  notes: `https://github.com/${repo}/releases/tag/v${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
};
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json: ${Object.keys(platforms).length} targets`);
