'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type {
  AuthResponse,
  LoginBody,
  RegisterBody,
  UpdateProfileBody,
  User,
} from '@coach/shared';
import { apiFetch, clearStoredToken, getStoredToken, setStoredToken } from './api';

interface AuthContextValue {
  user: User | null;
  /** True until we've finished checking whether a stored token is still valid. */
  loading: boolean;
  login: (body: LoginBody) => Promise<void>;
  register: (body: RegisterBody) => Promise<void>;
  updateProfile: (body: UpdateProfileBody) => Promise<void>;
  /** Re-fetch the current user — used after something outside this tab
   *  changes them (e.g. linking Telegram happens in the Telegram app). */
  refreshUser: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  // We're only "loading" if there's actually a stored token worth validating.
  // A lazy initializer (rather than `useState(true)` + an effect that
  // immediately sets it false) avoids a synchronous setState inside the
  // effect, which costs an extra render on every mount — React 19's
  // `react-hooks/set-state-in-effect` rule flags that, correctly.
  //
  // This DOES evaluate differently on server (always false — no localStorage)
  // than on client, but it never reaches the DOM: RequireAuth renders null
  // both while loading and while logged out, so the server's HTML and the
  // client's first render agree regardless.
  const [loading, setLoading] = useState(() => getStoredToken() !== null);

  // If a token survived from a previous visit, don't just trust it — ask the
  // API who it actually belongs to. A stored token can be expired, or the
  // server's JWT_SECRET could have rotated since it was issued; /auth/me is
  // the source of truth and localStorage is only a cache.
  useEffect(() => {
    if (!getStoredToken()) return; // nothing to validate; `loading` is already false
    let cancelled = false;
    apiFetch<User>('/auth/me')
      .then((me) => !cancelled && setUser(me))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // See the comment on apiFetch in lib/api.ts: it can't navigate directly,
  // so a 401 anywhere in the app arrives here as an event instead. This is
  // what actually clears the logged-in state — RequireAuth reacts to `user`
  // becoming null and does the navigation.
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener('coach:unauthorized', onUnauthorized);
    return () => window.removeEventListener('coach:unauthorized', onUnauthorized);
  }, []);

  async function login(body: LoginBody) {
    const res = await apiFetch<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setStoredToken(res.token);
    setUser(res.user);
  }

  async function register(body: RegisterBody) {
    const res = await apiFetch<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setStoredToken(res.token);
    setUser(res.user);
  }

  // Updates the server, then replaces the cached user with whatever came
  // back — never with what we sent. The response is the authoritative record
  // of what was actually saved (the API may normalise or reject fields), so
  // trusting our own optimistic copy is how UI drifts out of sync with truth.
  async function updateProfile(body: UpdateProfileBody) {
    const updated = await apiFetch<User>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    setUser(updated);
  }

  async function refreshUser() {
    try {
      setUser(await apiFetch<User>('/auth/me'));
    } catch {
      // A failure here is either a network blip or an expired session; the
      // latter already triggers the 'coach:unauthorized' event via apiFetch,
      // so there's nothing extra to do.
    }
  }

  function logout() {
    clearStoredToken();
    setUser(null);
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, login, register, updateProfile, refreshUser, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
