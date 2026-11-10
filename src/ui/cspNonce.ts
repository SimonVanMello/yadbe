import { setNonce } from 'get-nonce';

/**
 * Nonce of the page's `<style>` tags, or `null` when the CSP has none (`tauri dev`, browser).
 * Outside `tauri dev`, Tauri adds nonces to the CSP, which makes the webview ignore
 * 'unsafe-inline': a library that injects a `<style>` tag must put this nonce on it.
 */
export function styleNonce(): string | null {
  return document.querySelector<HTMLStyleElement>('style[nonce]')?.nonce || null;
}

/**
 * Hands the nonce to the libraries that inject styles at runtime: Radix's scroll lock
 * (`react-remove-scroll-bar`, used by modal dialogs) reads it through `get-nonce`.
 */
export function shareStyleNonce(): void {
  const nonce = styleNonce();
  if (nonce !== null) setNonce(nonce);
}
