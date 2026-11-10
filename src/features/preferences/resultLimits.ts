import type { ResultLimits } from '../../ipc';
import { getPreference } from './preferenceStore';

const BYTES_PER_MB = 1024 * 1024;

/** When a result pauses, from the preferences: what a run sends as its `limits`. */
export function resultLimits(): ResultLimits {
  return {
    maxRows: getPreference('resultMaxRows'),
    maxBytes: getPreference('resultMaxMb') * BYTES_PER_MB,
  };
}
