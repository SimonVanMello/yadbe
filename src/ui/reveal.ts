/** Sent to the open `Disclosure` sections: open yourself if you hold this `data-field`. */
export const REVEAL_FIELD_EVENT = 'yadbe-reveal-field';

/**
 * Focuses the control marked `data-field={name}`, first opening the closed `Disclosure` that
 * holds it (a closed section does not render its fields). Returns whether a control was found.
 */
export function focusField(name: string): boolean {
  document.dispatchEvent(new CustomEvent<string>(REVEAL_FIELD_EVENT, { detail: name }));
  const control = document.querySelector<HTMLElement>(`[data-field="${name}"]`);
  control?.focus();
  return control !== null;
}
