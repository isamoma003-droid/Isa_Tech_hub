import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized, tokenStore } from '../api/client.js';

const AuthContext = createContext(null);

// Who can do what (the API enforces the same rules):
//   admin    the ISA Tech team: everything, including approving merchants and pricing.
//   viewer   the ISA Tech team, read-only.
//   merchant a business using IsaPay: changes only its own platforms and tills.
export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [admin, setAdmin] = useState(null);
  const [checking, setChecking] = useState(() => Boolean(tokenStore.get()));

  const signOut = useCallback(() => {
    tokenStore.set(null);
    setAdmin(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => onUnauthorized(signOut), [signOut]);

  useEffect(() => {
    if (!tokenStore.get()) return;
    api('/auth/me')
      .then(({ admin: me }) => setAdmin(me))
      .catch(() => tokenStore.set(null))
      .finally(() => setChecking(false));
  }, []);

  const value = useMemo(() => {
    // Every sign-in route answers { token, admin }.
    const start = ({ token, admin: me }) => {
      queryClient.clear();
      tokenStore.set(token);
      setAdmin(me);
      return me;
    };
    const role = admin?.role;
    return {
      admin,
      checking,
      isMerchant: role === 'merchant',
      isStaff: role === 'admin' || role === 'viewer',
      // An ISA Tech admin: approvals, pricing, enabling platforms, the team.
      isAdmin: role === 'admin',
      // Can change things at all (merchants: their own).
      canEdit: role === 'admin' || role === 'merchant',
      signIn: (email, password) => api('/auth/login', { method: 'POST', body: { email, password } }).then(start),
      register: (body) => api('/auth/register', { method: 'POST', body }).then(start),
      googleSignIn: (credential) => api('/auth/google', { method: 'POST', body: { credential } }).then(start),
      // A password change or reset issues a new token (other sessions are signed out).
      replaceSession: start,
      // After a profile change.
      setAdmin,
      refresh: () => api('/auth/me').then(({ admin: me }) => setAdmin(me)),
      signOut,
    };
  }, [admin, checking, signOut, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
