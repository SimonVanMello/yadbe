import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Colors of the SQL tokens, from the theme's `--syn-*` tokens (AA contrast on the editor
 * surface, checked by `contrast.node.test.ts`).
 */
const sqlHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.typeName, tags.standard(tags.typeName)], color: 'var(--syn-type)' },
  {
    tag: [tags.function(tags.variableName), tags.standard(tags.name)],
    color: 'var(--syn-function)',
  },
  {
    tag: [tags.special(tags.name), tags.special(tags.variableName), tags.atom],
    color: 'var(--syn-special)',
  },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: 'var(--syn-operator)' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], color: 'var(--syn-comment)' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

/**
 * Editor chrome from the design tokens only: both themes switch by their CSS variables, no
 * color is written here. (CodeMirror injects these rules as a `<style>` tag: the editor gets the
 * page's CSP nonce, see `SqlEditor.tsx`.)
 */
const chrome = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--fg-primary)',
    backgroundColor: 'var(--bg-input)',
    fontSize: 'var(--text-md)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: 'var(--leading-normal)',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--accent)', padding: 'var(--space-2) 0' },
  '.cm-line': { padding: '0 var(--space-4)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-input)',
    color: 'var(--fg-muted)',
    border: 'none',
    borderRight: 'var(--border-width) solid var(--border-subtle)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--space-3) 0 var(--space-4)' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-primary)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--editor-selection)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection)',
  },
  '.cm-content ::selection': { backgroundColor: 'var(--editor-selection)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--editor-bracket-match)',
    outline: 'none',
  },
  '&.cm-focused .cm-nonmatchingBracket': { color: 'var(--danger)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-search-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--editor-search-match)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--editor-selection)' },
  '.cm-statement-highlight': { backgroundColor: 'var(--editor-statement)' },
  '.cm-error-range': {
    textDecoration: 'underline wavy var(--danger)',
    textUnderlineOffset: '3px',
    textDecorationThickness: '1.5px',
  },
  // Find and replace panel.
  '.cm-panels': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--fg-primary)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--text-sm)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: 'var(--border-width) solid var(--border-subtle)' },
  '.cm-panels.cm-panels-bottom': { borderTop: 'var(--border-width) solid var(--border-subtle)' },
  '.cm-search': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' },
  '.cm-search br': { display: 'none' },
  '.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    color: 'var(--fg-secondary)',
    fontSize: 'var(--text-xs)',
  },
  '.cm-textfield': {
    height: 'var(--control-height-sm)',
    padding: '0 var(--space-2)',
    color: 'var(--fg-primary)',
    backgroundColor: 'var(--bg-input)',
    border: 'var(--border-width) solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-code)',
    fontSize: 'var(--text-sm)',
  },
  '.cm-textfield:focus-visible': {
    outline: 'var(--focus-ring-width) solid var(--accent)',
    outlineOffset: '0',
  },
  '.cm-button': {
    height: 'var(--control-height-sm)',
    padding: '0 var(--space-3)',
    color: 'var(--fg-primary)',
    backgroundImage: 'none',
    backgroundColor: 'var(--bg-hover)',
    border: 'var(--border-width) solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  },
  '.cm-button:hover': { backgroundColor: 'var(--bg-active)' },
  '.cm-button:focus-visible': {
    outline: 'var(--focus-ring-width) solid var(--accent)',
    outlineOffset: '0',
  },
  '.cm-panel.cm-search [name=close]': { color: 'var(--fg-secondary)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--fg-primary)',
    border: 'var(--border-width) solid var(--border-strong)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-popover)',
  },
  // Suggestions (F-043): the list, one row per suggestion with a kind mark, name and detail.
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-code)',
    fontSize: 'var(--text-sm)',
    maxHeight: 'calc(var(--row-height) * 10)',
    minWidth: 'var(--menu-min-width)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: 'var(--space-0) var(--space-3)',
    lineHeight: 'var(--leading-normal)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-fg)',
  },
  '.cm-completionLabel': { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-completionDetail': {
    flex: '0 1 auto',
    marginLeft: 'var(--space-4)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontStyle: 'normal',
    fontSize: 'var(--text-xs)',
    color: 'var(--fg-muted)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': {
    color: 'inherit',
    opacity: '0.8',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 'var(--weight-semibold)' },
  '.cm-yadbe-kind': {
    flex: 'none',
    order: '-1',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 'var(--icon-size-md)',
    height: 'var(--icon-size-md)',
    borderRadius: 'var(--radius-sm)',
    border: 'var(--border-width) solid currentColor',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--text-2xs)',
    fontWeight: 'var(--weight-semibold)',
    lineHeight: '1',
    opacity: '0.9',
  },
  '.cm-yadbe-kind[data-kind="table"], .cm-yadbe-kind[data-kind="view"], .cm-yadbe-kind[data-kind="materializedView"]':
    { color: 'var(--syn-type)' },
  '.cm-yadbe-kind[data-kind="schema"], .cm-yadbe-kind[data-kind="cte"]': {
    color: 'var(--syn-special)',
  },
  '.cm-yadbe-kind[data-kind="column"], .cm-yadbe-kind[data-kind="alias"], .cm-yadbe-kind[data-kind="join"]':
    { color: 'var(--syn-string)' },
  '.cm-yadbe-kind[data-kind="function"], .cm-yadbe-kind[data-kind="procedure"]': {
    color: 'var(--syn-function)',
  },
  '.cm-yadbe-kind[data-kind="keyword"], .cm-yadbe-kind[data-kind="type"]': {
    color: 'var(--syn-keyword)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-yadbe-kind': {
    color: 'inherit',
  },
  // The panel next to the list.
  '.cm-completionInfo': {
    padding: 'var(--space-3) var(--space-4)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--text-sm)',
    maxWidth: 'var(--card-min-width)',
    color: 'var(--fg-secondary)',
  },
  '.cm-yadbe-info-title': {
    marginBottom: 'var(--space-2)',
    fontFamily: 'var(--font-code)',
    fontWeight: 'var(--weight-semibold)',
    color: 'var(--fg-primary)',
    overflowWrap: 'anywhere',
  },
  '.cm-yadbe-info-row': {
    display: 'flex',
    gap: 'var(--space-3)',
    justifyContent: 'space-between',
    marginTop: 'var(--space-1)',
  },
  '.cm-yadbe-info-label': { color: 'var(--fg-muted)', flex: 'none' },
  '.cm-yadbe-info-value': {
    fontFamily: 'var(--font-code)',
    fontSize: 'var(--text-xs)',
    textAlign: 'right',
    overflowWrap: 'anywhere',
  },
  '.cm-yadbe-info-columns': {
    margin: 'var(--space-2) 0 0',
    padding: 'var(--space-2) 0 0',
    listStyle: 'none',
    borderTop: 'var(--border-width) solid var(--border-subtle)',
  },
  '.cm-yadbe-info-column': {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 'var(--space-4)',
    fontFamily: 'var(--font-code)',
    fontSize: 'var(--text-xs)',
  },
  '.cm-yadbe-info-name': { color: 'var(--fg-primary)' },
  '.cm-yadbe-info-type': { color: 'var(--syn-type)' },
  '.cm-yadbe-info-more': { color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' },
  '.cm-yadbe-info-comment': { marginTop: 'var(--space-2)', color: 'var(--fg-muted)' },
});

/** Highlighting and chrome of the SQL editor. */
export const sqlEditorTheme: Extension = [chrome, syntaxHighlighting(sqlHighlight)];
