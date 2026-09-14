'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// "/" has no content of its own — it just hands off to /dashboard, which is
// wrapped in RequireAuth and will bounce to /login on its own if there's no
// valid session. Keeping the "am I logged in" logic in exactly one place.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);
  return null;
}
