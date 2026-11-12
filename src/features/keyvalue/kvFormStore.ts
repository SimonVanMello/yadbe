import { create } from 'zustand';

/** The values a form returns, by field name. */
export type KvFormValues = Record<string, string | boolean>;

export interface KvFormField {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'switch';
  value: string | boolean;
  options?: readonly { value: string; label: string }[];
  mono?: boolean;
  hint?: string;
  placeholder?: string;
  /** Shown only when this holds for the current values. */
  visible?: (values: KvFormValues) => boolean;
}

/** A small form of a key edit (a value, a field, a time to live, a new name…). */
export interface KvFormRequest {
  title: string;
  description?: string;
  submitLabel: string;
  fields: KvFormField[];
  /** What is wrong with the values, `null` when they can be submitted. */
  validate?: (values: KvFormValues) => string | null;
  danger?: boolean;
}

interface PendingForm extends KvFormRequest {
  /** Changes with every request: the form starts from its own values. */
  seq: number;
  resolve: (values: KvFormValues | null) => void;
}

let nextSeq = 1;

interface KvFormStore {
  pending: PendingForm | null;
  settle: (values: KvFormValues | null) => void;
}

export const useKvFormStore = create<KvFormStore>()((set, get) => ({
  pending: null,
  settle: (values) => {
    get().pending?.resolve(values);
    set({ pending: null });
  },
}));

/** Asks for the values of a form; resolves `null` when dismissed. */
export function askForm(request: KvFormRequest): Promise<KvFormValues | null> {
  useKvFormStore.getState().settle(null);
  return new Promise((resolve) => {
    useKvFormStore.setState({ pending: { ...request, seq: nextSeq++, resolve } });
  });
}

export function text(values: KvFormValues, name: string): string {
  const value = values[name];
  return typeof value === 'string' ? value : '';
}

export function flag(values: KvFormValues, name: string): boolean {
  return values[name] === true;
}
