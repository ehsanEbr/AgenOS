import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query. Reads the correct value on the very first render (unlike hooks that start
 * as `undefined` and update in an effect), so responsive layouts do not flash the wrong variant.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
