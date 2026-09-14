'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

/**
 * Gate for any page that needs a logged-in user. This check can ONLY happen
 * here — client-side, after hydration — because the token lives in
 * localStorage, and neither Next Server Components nor Next Middleware can
 * read it (both run server-side; localStorage is a browser API).
 *
 * Rendering `null` while loading/unauthenticated is deliberate, not a
 * placeholder to tidy up later: the server always renders the LOGGED-OUT
 * shape of a page (it has no way to know otherwise), so rendering real
 * content before this check resolves causes a visible flash of protected
 * content right before the redirect fires.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) return null;
  return <>{children}</>;
}
