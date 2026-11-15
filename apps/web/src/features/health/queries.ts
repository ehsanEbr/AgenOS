import { useQuery } from '@tanstack/react-query';
import { getHealth } from './api';

/**
 * Query keys of this feature, in one place. Keys go from general to specific so invalidating `healthKeys.all`
 * also invalidates everything more specific.
 */
export const healthKeys = {
  all: ['health'] as const,
  liveness: () => [...healthKeys.all, 'liveness'] as const,
};

export function useApiHealth() {
  return useQuery({
    queryKey: healthKeys.liveness(),
    queryFn: ({ signal }) => getHealth(signal), // `signal` cancels the request when the component unmounts
    refetchInterval: 15_000,
  });
}
