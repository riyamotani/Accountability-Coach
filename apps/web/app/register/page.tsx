'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError } from '@/lib/api';
import { useDetectedTimezone } from '@/lib/hooks';
import { Button, Card, ErrorNote, Field, TextInput } from '@/components/ui';

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const timezone = useDetectedTimezone();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register({ email, password, displayName, timezone });
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
          <p className="mt-1 text-sm text-muted">Set goals, get nudged, stay honest.</p>
        </div>
        <Card>
          <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
            <Field label="Name">
              <TextInput
                required
                autoComplete="name"
                placeholder="Riya"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
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
                minLength={8}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <p className="text-xs text-muted">
              Timezone detected as{' '}
              <span className="font-medium text-foreground">{timezone || '…'}</span> — all your
              reminders will fire in this zone.
            </p>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-sm text-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
