import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';

/** Whether the hub's AI features are on, plus today's usage. Shared by the sidebar, the composer and Settings. */
export function useAiStatus(refetchMs = 5 * 60_000) {
  return useQuery({ queryKey: ['ai-status'], queryFn: api.aiStatus, staleTime: 60_000, refetchInterval: refetchMs, retry: false });
}

export const useAiEnabled = () => useAiStatus().data?.enabled === true;
