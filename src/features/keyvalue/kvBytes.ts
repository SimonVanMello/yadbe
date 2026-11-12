import type { KvBytes } from '../../ipc';

/** A stable string for a key or a value, to key maps and queries by (binary-safe). */
export function bytesId(bytes: KvBytes): string {
  return bytes.base64 === null ? `t:${bytes.text}` : `b:${bytes.base64}`;
}

export function textBytes(text: string): KvBytes {
  return { text, base64: null };
}

/** The exact bytes of a base64 string. */
export function decodeBase64(encoded: string): Uint8Array {
  const raw = atob(encoded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Bytes as text: UTF-8, invalid sequences shown as U+FFFD. */
export function bytesText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Whether bytes are valid UTF-8. */
export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const HEX = '0123456789abcdef';

/** A hex dump: offset, sixteen bytes, their printable form; one line per sixteen bytes. */
export function hexDump(bytes: Uint8Array, offset = 0): string {
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += 16) {
    const row = bytes.subarray(start, start + 16);
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      const b = row[i];
      if (b === undefined) {
        hex += '   ';
        continue;
      }
      hex += `${HEX[b >> 4] ?? ''}${HEX[b & 15] ?? ''} `;
      ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      if (i === 7) hex += ' ';
    }
    lines.push(`${(offset + start).toString(16).padStart(8, '0')}  ${hex} ${ascii}`);
  }
  return lines.join('\n');
}

/** Joins chunks read one after the other. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
