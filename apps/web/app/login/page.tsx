'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api';
import { Button, Card, ErrorNote, Field, TextInput } from '@/components/ui';

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login({ email, password });
      router.replace('/dashboard');
    } catch (err) {
      // Comes back identical whether the email doesn't exist or the password
      // is wrong — see the login route. Distinguishing them would turn this
      // form into an account-enumeration oracle.
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Accountability Coach</h1>
          <p className="mt-1 text-sm text-muted">Goals that check in on you.</p>
        </div>
        <Card>
          <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
            <Field label="Email">
              <TextInput
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <TextInput
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={busy}>
              {busy ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-sm text-muted">
          No account?{' '}
          <Link href="/register" className="font-medium text-accent hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}
