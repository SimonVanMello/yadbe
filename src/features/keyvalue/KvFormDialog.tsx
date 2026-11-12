import { KvFormBody } from './KvFormBody';
import { useKvFormStore } from './kvFormStore';

/** Renders the pending `askForm()` request (key edits). Mount once. */
export function KvFormDialog() {
  const seq = useKvFormStore((state) => state.pending?.seq ?? null);
  if (seq === null) return null;
  return <KvFormBody key={seq} />;
}
