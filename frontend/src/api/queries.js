import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryString } from './client.js';

export const useStats = () => useQuery({ queryKey: ['stats'], queryFn: () => api('/stats'), refetchInterval: 30_000 });

export const usePayments = (filters) =>
  useQuery({
    queryKey: ['payments', filters],
    queryFn: () => api(`/payments${queryString(filters)}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

export const usePayment = (id) =>
  useQuery({
    queryKey: ['payment', id],
    queryFn: () => api(`/payments/${id}`),
    // Keep a pending payment live on screen.
    refetchInterval: (query) => (query.state.data?.payment?.status === 'pending' ? 5_000 : false),
  });

export const usePlatforms = () => useQuery({ queryKey: ['platforms'], queryFn: () => api('/platforms') });
export const usePlatform = (id) => useQuery({ queryKey: ['platform', id], queryFn: () => api(`/platforms/${id}`) });
export const useTills = () => useQuery({ queryKey: ['tills'], queryFn: () => api('/tills') });
export const useTill = (id) => useQuery({ queryKey: ['till', id], queryFn: () => api(`/tills/${id}`) });
export const useAudit = (filters) =>
  useQuery({ queryKey: ['audit', filters], queryFn: () => api(`/audit${queryString(filters)}`), placeholderData: keepPreviousData });

// A mutation that refreshes the given query keys when it succeeds.
export function useAction(fn, invalidate = []) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
}
