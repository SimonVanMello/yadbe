/**
 * Puts text on the clipboard. The async Clipboard API first; WebKitGTK can refuse it outside a
 * direct user gesture (a copy that had to load rows first), so a hidden textarea and
 * `execCommand('copy')` is the fallback.
 */
export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the legacy path.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  const active = document.activeElement;
  area.select();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only fallback WebKitGTK has.
  const ok = document.execCommand('copy');
  area.remove();
  if (active instanceof HTMLElement) active.focus();
  if (!ok) throw new Error('The clipboard refused the text.');
}
