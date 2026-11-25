import type { Locator, Page } from '@playwright/test';

/**
 * Finds what "sticks out" of its box on the current page (M3-18): the layout mistakes that wider
 * fonts (macOS), longer translations (French) or longer data turn into visible defects.
 *
 * - `clipped`: text cut off without an ellipsis — by its own box or by a parent that hides its
 *   overflow (a toast, a fixed-height bar): text lost silently;
 * - `outside`: a child drawn past an edge of a parent that neither clips nor scrolls (typically a
 *   flex or grid child that cannot shrink, a fixed width or height, a `nowrap` label);
 * - `viewport`: an element past the right or bottom edge of the window, outside any scroll area.
 *
 * Tolerance: 1 px (sub-pixel layout). Ignored: transformed children (a turning spinner), hidden or
 * empty elements, absolutely / fixed positioned children (popovers, tooltips, badges placed on
 * purpose), visually hidden text for screen readers, SVG internals, form controls' own text (an
 * input scrolls its value), CodeMirror's internals (its own scroller), and whatever matches
 * `ignore` (with its subtree).
 */
export interface Overflow {
  kind: 'clipped' | 'outside' | 'viewport';
  /** A readable path to the element: tag, role or test id, CSS module class names. */
  element: string;
  /** The start of its text, to find it in a capture. */
  text: string;
  /** By how many pixels it overflows. */
  by: number;
}

export async function findOverflows(
  page: Page,
  options: { ignore?: readonly string[] } = {},
): Promise<Overflow[]> {
  return page.evaluate((ignoreList) => {
    const tolerance = 1;
    const ignore = ['.cm-editor', ...ignoreList].join(', ');
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const found: Overflow[] = [];

    /** CSS modules name classes `_name_hash_n`: keep the name. */
    const describe = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && current !== document.body && depth < 4; depth++) {
        const testId = current.getAttribute('data-testid');
        const role = current.getAttribute('role');
        const classes = [...current.classList]
          .map((name) => /^_([A-Za-z0-9]+)_/.exec(name)?.[1] ?? name)
          .slice(0, 2)
          .join('.');
        parts.unshift(
          `${current.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${
            testId ? `[${testId}]` : role ? `[role=${role}]` : ''
          }`,
        );
        current = current.parentElement;
      }
      return parts.join(' > ');
    };
    const textOf = (element: Element) =>
      (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const shown = (element: Element, style: CSSStyleDeclaration) => {
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      // Visually hidden text for screen readers (1 px box, clipped) is cut on purpose.
      if (style.clipPath !== 'none' || style.getPropertyValue('clip') !== 'auto') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };
    const ownText = (element: Element) =>
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
      );
    const formControl = (element: Element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement;
    /** Inside an element that scrolls or clips: its own overflow is not the window's. */
    const inScrollArea = (element: Element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent === document.body || parent === document.documentElement) return false;
        const style = getComputedStyle(parent);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return true;
      }
      return false;
    };

    for (const element of document.body.querySelectorAll('*')) {
      if (element instanceof SVGElement || element.closest(ignore)) continue;
      const style = getComputedStyle(element);
      if (!shown(element, style)) continue;
      const rect = element.getBoundingClientRect();

      if (!formControl(element) && ownText(element) && style.display !== 'inline') {
        const hidden = style.overflowX === 'hidden' || style.overflowX === 'clip';
        const cutX = element.scrollWidth - element.clientWidth;
        // A word longer than its box (a long name) is drawn past it.
        if (style.overflowX === 'visible' && cutX > tolerance) {
          found.push({
            kind: 'outside',
            element: describe(element),
            text: textOf(element),
            by: cutX,
          });
        }
        if (hidden && style.textOverflow !== 'ellipsis' && cutX > tolerance) {
          found.push({
            kind: 'clipped',
            element: describe(element),
            text: textOf(element),
            by: cutX,
          });
        }
        const hiddenY = style.overflowY === 'hidden' || style.overflowY === 'clip';
        const cutY = element.scrollHeight - element.clientHeight;
        const clamped = style.getPropertyValue('-webkit-line-clamp') !== 'none';
        if (hiddenY && !clamped && style.textOverflow !== 'ellipsis' && cutY > tolerance) {
          found.push({
            kind: 'clipped',
            element: describe(element),
            text: textOf(element),
            by: cutY,
          });
        }
      }

      // A child past its parent's box: drawn outside it when the parent lets it, cut off
      // (without an ellipsis) when the parent hides its overflow. A parent that scrolls is fine.
      const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll';
      const hides = (overflow: string) => overflow === 'hidden' || overflow === 'clip';
      for (const child of element.children) {
        if (child instanceof SVGElement || child.closest(ignore)) continue;
        const childStyle = getComputedStyle(child);
        if (childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
        // A turning spinner's box grows with its rotation.
        if (childStyle.transform !== 'none') continue;
        if (!shown(child, childStyle)) continue;
        const box = child.getBoundingClientRect();
        const byX = Math.max(box.right - rect.right, rect.left - box.left);
        const byY = Math.max(box.bottom - rect.bottom, rect.top - box.top);
        const ellipsis =
          style.textOverflow === 'ellipsis' || childStyle.textOverflow === 'ellipsis';
        for (const [by, overflow] of [
          [byX, style.overflowX],
          [byY, style.overflowY],
        ] as const) {
          if (by <= tolerance || scrolls(overflow)) continue;
          if (!hides(overflow)) {
            found.push({ kind: 'outside', element: describe(child), text: textOf(child), by });
          } else if (!ellipsis && textOf(child) !== '') {
            found.push({ kind: 'clipped', element: describe(child), text: textOf(child), by });
          }
        }
      }

      if (!inScrollArea(element)) {
        const by = Math.max(rect.right - viewportWidth, rect.bottom - viewportHeight);
        if (by > tolerance) {
          found.push({ kind: 'viewport', element: describe(element), text: textOf(element), by });
        }
      }
    }
    for (const overflow of found) overflow.by = Math.round(overflow.by);
    return found;
  }, options.ignore ?? []);
}

/**
 * Elements under `root` that scroll sideways (a horizontal scrollbar): `findOverflows` lets a
 * scrolling parent off, but a form that scrolls sideways is a layout defect all the same (M4-15).
 */
export async function sidewaysScrolls(root: Locator): Promise<string[]> {
  return root.evaluate((element) => {
    const found: string[] = [];
    for (const node of [element, ...element.querySelectorAll('*')]) {
      const style = getComputedStyle(node);
      if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
      if (node.scrollWidth - node.clientWidth > 1) {
        found.push(
          `${node.tagName.toLowerCase()}.${[...node.classList].join('.')} +${String(node.scrollWidth - node.clientWidth)}px`,
        );
      }
    }
    return found;
  });
}

/** How many rows a toolbar takes: the visible children's vertical centres that differ. */
export async function rowsOf(row: Locator): Promise<number> {
  return row.evaluate((element) => {
    const centres: number[] = [];
    for (const child of element.children) {
      const box = child.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const centre = box.top + box.height / 2;
      if (!centres.some((c) => Math.abs(c - centre) < 4)) centres.push(centre);
    }
    return centres.length;
  });
}

/** How many lines of text an element shows (its height over its line height). */
export async function linesOf(text: Locator): Promise<number> {
  return text.evaluate((element) => {
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    return Math.round(element.getBoundingClientRect().height / line);
  });
}
