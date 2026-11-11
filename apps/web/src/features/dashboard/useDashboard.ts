import { useMutation, useQuery } from '@tanstack/react-query';
import type { SystemJob } from '@agentos/contracts';
import { api } from '../../shared/api/client';

const isTerminal = (job: SystemJob | undefined) => job?.status === 'COMPLETED' || job?.status === 'FAILED';

export function useReadiness() {
  return useQuery({
    queryKey: ['health', 'ready'],
    queryFn: ({ signal }) => api.getReadiness(signal),
    refetchInterval: 10_000,
  });
}

export function useCreateSystemJob() {
  return useMutation({ mutationFn: api.createSystemJob });
}

/** Polls a job until it reaches a terminal state. */
export function useSystemJob(id: string | undefined) {
  return useQuery({
    queryKey: ['system-jobs', id],
    queryFn: ({ signal }) => api.getSystemJob(id!, signal),
    enabled: id !== undefined,
    refetchInterval: (query) => (isTerminal(query.state.data) ? false : 1000),
  });
}
