import type { ApiError } from '@coach/shared';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const STORAGE_KEY = 'coach.auth';

/**
 * localStorage is a browser-only API. This module gets imported by code that
 * Next may also evaluate during server-side rendering, so every access is
 * guarded — `typeof window === 'undefined'` is how you detect "this is
 * running on the server" in code that has to work in both places.
 */
export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing / disabled storage can throw on access, not just
    // return null. Treat that the same as "not logged in" rather than crash.
    return null;
  }
}

export function setStoredToken(token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * The one place every HTTP call to our API goes through. Two jobs beyond a
 * plain fetch: attach the bearer token automatically, and react to a 401 the
 * SAME way everywhere, instead of every call site remembering to handle it.
 *
 * This is a plain function, not a hook — it cannot call useRouter() itself
 * (hooks only work inside components/other hooks). So a 401 doesn't navigate
 * directly; it clears storage and dispatches a browser event. AuthProvider
 * (a real component, see auth-context.tsx) listens for that event and clears
 * its React state — THAT is what actually triggers RequireAuth's redirect.
 */
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    clearStoredToken();
    window.dispatchEvent(new Event('coach:unauthorized'));
    throw new ApiRequestError('Not authenticated', 401);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(body?.error ?? `Request failed (${res.status})`, res.status);
  }

  // Our DELETE routes return 204 No Content — there is no body to parse.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
