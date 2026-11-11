import type { MessageKey } from '../../i18n/i18n';
import type { IconName } from '../../ui/Icon';
import { PAGE_SIZES, TAB_SIZES, type PreferenceKey } from './preferenceSchema';

export const SECTION_IDS = [
  'appearance',
  'editor',
  'results',
  'history',
  'connections',
  'about',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export interface SectionInfo {
  id: SectionId;
  icon: IconName;
  label: MessageKey;
  description: MessageKey;
}

export const SECTIONS: readonly SectionInfo[] = [
  {
    id: 'appearance',
    icon: 'palette',
    label: 'preferences.section.appearance',
    description: 'preferences.section.appearance.desc',
  },
  {
    id: 'editor',
    icon: 'terminal',
    label: 'preferences.section.editor',
    description: 'preferences.section.editor.desc',
  },
  {
    id: 'results',
    icon: 'table',
    label: 'preferences.section.results',
    description: 'preferences.section.results.desc',
  },
  {
    id: 'history',
    icon: 'history',
    label: 'preferences.section.history',
    description: 'preferences.section.history.desc',
  },
  {
    id: 'connections',
    icon: 'database',
    label: 'preferences.section.connections',
    description: 'preferences.section.connections.desc',
  },
  {
    id: 'about',
    icon: 'info',
    label: 'preferences.section.about',
    description: 'preferences.section.about.desc',
  },
];

export function isSectionId(value: unknown): value is SectionId {
  return (SECTION_IDS as readonly unknown[]).includes(value);
}

export interface ChoiceOption {
  value: string;
  /** Translated name; `text` stands in for the ones that are just a number. */
  label?: MessageKey;
  text?: string;
}

export function optionLabel(option: ChoiceOption, t: (key: MessageKey) => string): string {
  return option.label ? t(option.label) : (option.text ?? option.value);
}

/** How a setting is edited. `custom` ones are informative or open another dialog. */
export type ControlSpec =
  | { type: 'toggle' }
  | { type: 'segmented'; options: readonly ChoiceOption[] }
  | { type: 'select'; options: readonly ChoiceOption[] }
  | { type: 'number'; unit?: MessageKey }
  | { type: 'text'; placeholder?: MessageKey; mono?: boolean }
  | { type: 'custom' };

export type SettingId =
  | 'theme'
  | 'locale'
  | 'density'
  | 'uiFontSize'
  | 'editorFontFamily'
  | 'editorFontSize'
  | 'gridFontFamily'
  | 'gridFontSize'
  | 'completeAsYouType'
  | 'tabSize'
  | 'indentWithSpaces'
  | 'lineWrapping'
  | 'lineNumbers'
  | 'highlightStatement'
  | 'confirmDangerous'
  | 'resultMaxRows'
  | 'resultMaxMb'
  | 'defaultPageSize'
  | 'nullText'
  | 'nullStyle'
  | 'copyHeaders'
  | 'previewBeforeApply'
  | 'displayFormats'
  | 'historyEnabled'
  | 'historyMaxEntries'
  | 'historyMaxAgeDays'
  | 'clearHistory'
  | 'connectTimeoutSecs'
  | 'tlsRule'
  | 'keychain'
  | 'sshKnownHosts'
  | 'version'
  | 'platform'
  | 'license';

export interface SettingSpec {
  id: SettingId;
  section: SectionId;
  /** The preference it edits; `null` for the informative ones. */
  key: PreferenceKey | null;
  control: ControlSpec;
  /** More words the search matches, besides the label and the hint. */
  keywords?: string;
}

const toggle: ControlSpec = { type: 'toggle' };
const number = (unit?: MessageKey): ControlSpec =>
  unit ? { type: 'number', unit } : { type: 'number' };
const custom: ControlSpec = { type: 'custom' };

const themeOptions: readonly ChoiceOption[] = [
  { value: 'light', label: 'settings.theme.light' },
  { value: 'dark', label: 'settings.theme.dark' },
  { value: 'system', label: 'settings.theme.system' },
];

/** Every setting, in the order a section shows them. */
export const SETTINGS: readonly SettingSpec[] = [
  {
    id: 'theme',
    section: 'appearance',
    key: 'theme',
    control: { type: 'segmented', options: themeOptions },
    keywords: 'dark light graphite paper',
  },
  {
    id: 'locale',
    section: 'appearance',
    key: 'locale',
    control: {
      type: 'segmented',
      options: [
        { value: 'en', label: 'preferences.language.en' },
        { value: 'fr', label: 'preferences.language.fr' },
      ],
    },
    keywords: 'english français',
  },
  {
    id: 'density',
    section: 'appearance',
    key: 'density',
    control: {
      type: 'segmented',
      options: [
        { value: 'comfortable', label: 'preferences.density.comfortable' },
        { value: 'compact', label: 'preferences.density.compact' },
      ],
    },
    keywords: 'rows padding spacing',
  },
  {
    id: 'uiFontSize',
    section: 'appearance',
    key: 'uiFontSize',
    control: number('preferences.unit.px'),
    keywords: 'zoom text',
  },
  {
    id: 'editorFontFamily',
    section: 'appearance',
    key: 'editorFontFamily',
    control: { type: 'text', placeholder: 'preferences.font.placeholder', mono: true },
    keywords: 'font monospace',
  },
  {
    id: 'editorFontSize',
    section: 'appearance',
    key: 'editorFontSize',
    control: number('preferences.unit.px'),
  },
  {
    id: 'gridFontFamily',
    section: 'appearance',
    key: 'gridFontFamily',
    control: { type: 'text', placeholder: 'preferences.font.placeholder', mono: true },
    keywords: 'font monospace',
  },
  {
    id: 'gridFontSize',
    section: 'appearance',
    key: 'gridFontSize',
    control: number('preferences.unit.px'),
  },

  {
    id: 'completeAsYouType',
    section: 'editor',
    key: 'completeAsYouType',
    control: toggle,
    keywords: 'suggestions autocomplete',
  },
  {
    id: 'tabSize',
    section: 'editor',
    key: 'tabSize',
    control: {
      type: 'segmented',
      options: TAB_SIZES.map((size) => ({ value: String(size), text: String(size) })),
    },
    keywords: 'indent',
  },
  {
    id: 'indentWithSpaces',
    section: 'editor',
    key: 'indentWithSpaces',
    control: toggle,
    keywords: 'tabs indent',
  },
  { id: 'lineWrapping', section: 'editor', key: 'lineWrapping', control: toggle, keywords: 'wrap' },
  { id: 'lineNumbers', section: 'editor', key: 'lineNumbers', control: toggle, keywords: 'gutter' },
  { id: 'highlightStatement', section: 'editor', key: 'highlightStatement', control: toggle },
  {
    id: 'confirmDangerous',
    section: 'editor',
    key: 'confirmDangerous',
    control: toggle,
    keywords: 'delete update truncate drop prod safety',
  },

  {
    id: 'resultMaxRows',
    section: 'results',
    key: 'resultMaxRows',
    control: number('preferences.unit.rows'),
    keywords: 'limit cap',
  },
  {
    id: 'resultMaxMb',
    section: 'results',
    key: 'resultMaxMb',
    control: number('preferences.unit.mb'),
    keywords: 'limit cap memory',
  },
  {
    id: 'defaultPageSize',
    section: 'results',
    key: 'defaultPageSize',
    control: {
      type: 'select',
      options: PAGE_SIZES.map((size) => ({ value: String(size), text: String(size) })),
    },
    keywords: 'table rows',
  },
  { id: 'nullText', section: 'results', key: 'nullText', control: { type: 'text' } },
  {
    id: 'nullStyle',
    section: 'results',
    key: 'nullStyle',
    control: {
      type: 'segmented',
      options: [
        { value: 'italic', label: 'preferences.nullStyle.italic' },
        { value: 'plain', label: 'preferences.nullStyle.plain' },
      ],
    },
  },
  {
    id: 'copyHeaders',
    section: 'results',
    key: 'copyHeaders',
    control: toggle,
    keywords: 'clipboard',
  },
  {
    id: 'previewBeforeApply',
    section: 'results',
    key: 'previewBeforeApply',
    control: toggle,
    keywords: 'edit changes sql',
  },
  {
    id: 'displayFormats',
    section: 'results',
    key: null,
    control: custom,
    keywords: 'date time number iso',
  },

  { id: 'historyEnabled', section: 'history', key: 'historyEnabled', control: toggle },
  {
    id: 'historyMaxEntries',
    section: 'history',
    key: 'historyMaxEntries',
    control: number('preferences.unit.entries'),
    keywords: 'retention',
  },
  {
    id: 'historyMaxAgeDays',
    section: 'history',
    key: 'historyMaxAgeDays',
    control: number('preferences.unit.days'),
    keywords: 'retention',
  },
  { id: 'clearHistory', section: 'history', key: null, control: custom, keywords: 'delete' },

  {
    id: 'connectTimeoutSecs',
    section: 'connections',
    key: 'connectTimeoutSecs',
    control: number('preferences.unit.seconds'),
    keywords: 'timeout',
  },
  {
    id: 'tlsRule',
    section: 'connections',
    key: null,
    control: custom,
    keywords: 'ssl certificate verify',
  },
  {
    id: 'keychain',
    section: 'connections',
    key: null,
    control: custom,
    keywords: 'password secret',
  },
  {
    id: 'sshKnownHosts',
    section: 'connections',
    key: null,
    control: custom,
    keywords: 'ssh tunnel host key fingerprint known_hosts',
  },

  { id: 'version', section: 'about', key: null, control: custom },
  { id: 'platform', section: 'about', key: null, control: custom, keywords: 'os architecture' },
  { id: 'license', section: 'about', key: null, control: custom, keywords: 'gpl open source' },
];

export function settingsOf(section: SectionId): SettingSpec[] {
  return SETTINGS.filter((setting) => setting.section === section);
}

type Translate = (key: MessageKey) => string;

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The text of a setting the search looks in: label, hint, the labels of its choices. */
function haystack(setting: SettingSpec, t: Translate): string {
  const parts = [
    t(`preferences.setting.${setting.id}`),
    t(`preferences.setting.${setting.id}.hint`),
    setting.keywords ?? '',
  ];
  if (setting.control.type === 'segmented' || setting.control.type === 'select') {
    for (const option of setting.control.options) parts.push(optionLabel(option, t));
  }
  return fold(parts.join(' '));
}

/**
 * Ids of the settings that match `query`: every word of it must appear (accents and case do
 * not matter). `null` when the query is empty (nothing is filtered).
 */
export function searchSettings(query: string, t: Translate): ReadonlySet<SettingId> | null {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const found = new Set<SettingId>();
  for (const setting of SETTINGS) {
    const text = haystack(setting, t);
    if (words.every((word) => text.includes(word))) found.add(setting.id);
  }
  return found;
}

export function countBySection(found: ReadonlySet<SettingId>): ReadonlyMap<SectionId, number> {
  const counts = new Map<SectionId, number>();
  for (const setting of SETTINGS) {
    if (found.has(setting.id)) counts.set(setting.section, (counts.get(setting.section) ?? 0) + 1);
  }
  return counts;
}
