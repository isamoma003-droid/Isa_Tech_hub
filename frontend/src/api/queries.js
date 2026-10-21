import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, api, queryString } from './client.js';

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
export const usePaymentLinks = () => useQuery({ queryKey: ['payment-links'], queryFn: () => api('/payment-links') });
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

// Whether the API answers. Polling it also keeps a free Render service awake while the dashboard is open.
export const useHealth = () =>
  useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/health`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    retry: false,
  });

export const useBilling = () => useQuery({ queryKey: ['billing'], queryFn: () => api('/billing'), refetchInterval: 60_000 });
export const useInvoices = (filters) =>
  useQuery({ queryKey: ['invoices', filters], queryFn: () => api(`/invoices${queryString(filters)}`), placeholderData: keepPreviousData });

// What the sign-in page can offer: sign-up, Google, email. Public.
export const useAuthConfig = () =>
  useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api('/auth/config', { signal: AbortSignal.timeout(30_000) }),
    staleTime: 5 * 60_000,
    retry: 1,
  });

// Staff: the team and the merchants that signed up.
export const useAccounts = (filters) =>
  useQuery({ queryKey: ['accounts', filters], queryFn: () => api(`/accounts${queryString(filters)}`), placeholderData: keepPreviousData });
export const useAccount = (id) => useQuery({ queryKey: ['account', id], queryFn: () => api(`/accounts/${id}`) });
