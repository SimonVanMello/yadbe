import { useEffect, useState } from 'react';

/** `value` once it has stayed the same for `ms` (e.g. a cell under a held arrow key). */
export function useDebouncedValue<T extends string | number | null>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}
