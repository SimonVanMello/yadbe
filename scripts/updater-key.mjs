// Checks that a Tauri configuration carries an updater public key, as `pnpm tauri signer
// generate` writes it (base64 of a minisign public key file), and prints its key ID. The
// release workflow runs it on tags: installed copies verify every update with this key.
// Usage: node scripts/updater-key.mjs <tauri.conf.json>
import { readFileSync } from 'node:fs';

const [path] = process.argv.slice(2);
if (!path) fail('Usage: node scripts/updater-key.mjs <tauri.conf.json>');

const config = JSON.parse(readFileSync(path, 'utf8'));
const pubkey = config.plugins?.updater?.pubkey;
if (typeof pubkey !== 'string' || pubkey.trim() === '') {
  fail(
    'plugins.updater.pubkey is empty: paste the public key of the release key pair (docs/RELEASING.md).',
  );
}
if (config.plugins.updater.requireSignedVersion !== true) {
  fail('plugins.updater.requireSignedVersion must stay true (docs/RELEASING.md).');
}

// The file: `untrusted comment: minisign public key: <KEY ID>` then the key, base64 of
// "Ed" + 8 bytes of key ID + 32 bytes of Ed25519 key.
const text = Buffer.from(pubkey.trim(), 'base64').toString('utf8');
const [comment, key] = text.split('\n').map((line) => line.trim());
const bytes = Buffer.from(key ?? '', 'base64');
if (
  !comment?.startsWith('untrusted comment: ') ||
  bytes.length !== 42 ||
  bytes.subarray(0, 2).toString('latin1') !== 'Ed'
) {
  fail('plugins.updater.pubkey is not a minisign public key: paste the whole `.key.pub` file.');
}
const keyId = Buffer.from(bytes.subarray(2, 10)).reverse().toString('hex').toUpperCase();
console.log(`updater public key ${keyId}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
