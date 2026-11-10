// Fails when two tracked files differ only by case. macOS and Windows file systems are
// case-insensitive: such files collide there, and `./Foo` may resolve to `foo.ts` instead of
// `Foo.tsx` (extensionless imports), which breaks the app on those systems only.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((file) => file && existsSync(file));

const seen = new Map();
const clashes = [];
for (const file of files) {
  const keys = new Set([file.toLowerCase(), file.replace(/\.(m?[jt]sx?)$/, '').toLowerCase()]);
  for (const key of keys) {
    const other = seen.get(key);
    if (other !== undefined && other !== file) clashes.push(`${other}  <->  ${file}`);
    else seen.set(key, file);
  }
}

if (clashes.length > 0) {
  console.error('Paths that differ only by case (they clash on macOS and Windows):');
  for (const clash of clashes) console.error(`  ${clash}`);
  process.exit(1);
}
