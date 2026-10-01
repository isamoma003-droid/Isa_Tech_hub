import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized, tokenStore } from '../api/client.js';

const AuthContext = createContext(null);

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

  const value = useMemo(
    () => ({
      admin,
      checking,
      canEdit: admin?.role === 'admin',
      signIn: async (email, password) => {
        const result = await api('/auth/login', { method: 'POST', body: { email, password } });
        tokenStore.set(result.token);
        setAdmin(result.admin);
      },
      // After a password change the server issues a new token (others are revoked).
      replaceSession: ({ token, admin: me }) => {
        tokenStore.set(token);
        setAdmin(me);
      },
      signOut,
    }),
    [admin, checking, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
