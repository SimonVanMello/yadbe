import { create } from 'zustand';

import type { ParameterKind, ParameterValue, QueryParameter } from '../../ipc';

/** The last value given to a parameter, with its type. */
export interface RememberedValue {
  kind: ParameterKind;
  value: string;
}

interface PendingPrompt {
  tabId: string;
  parameters: QueryParameter[];
  resolve: (values: ParameterValue[] | null) => void;
}

interface ParameterStore {
  /** Per tab, per parameter name (F-048): what the prompt starts from next time. */
  remembered: Record<string, Record<string, RememberedValue>>;
  /** The prompt on screen. */
  pending: PendingPrompt | null;
  remember: (tabId: string, values: readonly ParameterValue[]) => void;
  forget: (tabId: string) => void;
  /** Answers the prompt: the values to run with, or `null` (cancelled). */
  settle: (values: ParameterValue[] | null) => void;
}

export const useParameterStore = create<ParameterStore>()((set, get) => ({
  remembered: {},
  pending: null,
  remember: (tabId, values) => {
    set((state) => ({
      remembered: {
        ...state.remembered,
        [tabId]: {
          ...state.remembered[tabId],
          ...Object.fromEntries(
            values.map((v) => [v.name, { kind: v.kind, value: v.value } satisfies RememberedValue]),
          ),
        },
      },
    }));
  },
  forget: (tabId) => {
    set((state) => ({
      remembered: Object.fromEntries(
        Object.entries(state.remembered).filter(([id]) => id !== tabId),
      ),
    }));
  },
  settle: (values) => {
    const pending = get().pending;
    if (!pending) return;
    if (values) get().remember(pending.tabId, values);
    set({ pending: null });
    pending.resolve(values);
  },
}));

/** Asks for the values of `parameters` in the tab's prompt; `null` when cancelled. */
export function askParameters(
  tabId: string,
  parameters: QueryParameter[],
): Promise<ParameterValue[] | null> {
  useParameterStore.getState().settle(null);
  return new Promise((resolve) => {
    useParameterStore.setState({ pending: { tabId, parameters, resolve } });
  });
}

/** The values the tab used last for every one of `parameters`, `null` when one is new. */
export function rememberedValues(
  tabId: string,
  parameters: readonly QueryParameter[],
): ParameterValue[] | null {
  const known = useParameterStore.getState().remembered[tabId] ?? {};
  const values: ParameterValue[] = [];
  for (const parameter of parameters) {
    const value = known[parameter.name];
    if (!value) return null;
    values.push({ name: parameter.name, ...value });
  }
  return values;
}

/** The value a field starts from: the last one, else empty text. */
export function initialValue(tabId: string, parameter: QueryParameter): RememberedValue {
  return (
    useParameterStore.getState().remembered[tabId]?.[parameter.name] ?? { kind: 'text', value: '' }
  );
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}(:?\d{2})?|Z)?$/i;

/** Whether `value` fits `kind`, as the backend checks it (it checks again). */
export function isValidValue(kind: ParameterKind, value: string): boolean {
  const text = value.trim();
  switch (kind) {
    case 'text':
    case 'null':
      return true;
    case 'number':
      return NUMBER.test(text);
    case 'boolean':
      return /^(true|false|1|0|t|f|yes|no)$/i.test(text);
    case 'dateTime': {
      if (DATE.test(text) || TIME.test(text)) return true;
      const date = text.slice(0, 10);
      const separator = text.charAt(10);
      return (
        DATE.test(date) && (separator === ' ' || separator === 'T') && TIME.test(text.slice(11))
      );
    }
  }
}

/** How a parameter reads in the prompt: `? #2` for positional ones, as written otherwise. */
export function parameterLabel(parameter: QueryParameter): string {
  return parameter.style === 'positional' ? `? ${parameter.name}` : parameter.label;
}
