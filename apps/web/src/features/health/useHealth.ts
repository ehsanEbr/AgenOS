import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';

export function useApiHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.getHealth(signal),
    refetchInterval: 15_000,
  });
}
