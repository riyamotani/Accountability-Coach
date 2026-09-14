'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { RequireAuth } from '@/components/RequireAuth';
import { Button, Card, ErrorNote, Field, SectionTitle, TextInput } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { apiFetch, ApiRequestError } from '@/lib/api';
import { useDetectedTimezone } from '@/lib/hooks';
import type { LinkCodeResponse, User } from '@coach/shared';

/**
 * A real page rather than a modal on the dashboard, because a planned BYO
 * Claude API key setting will land here later — settings will grow, and
 * growing a page is easier than growing a modal.
 */
function SettingsContent() {
  const { user, updateProfile } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [timezone, setTimezone] = useState(user?.timezone ?? '');
  const detected = useDetectedTimezone();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await updateProfile({ displayName, timezone });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  const driftedFromDevice = detected !== '' && detected !== timezone;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-6 py-3.5">
          <p className="text-sm font-semibold">Settings</p>
          <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
            ← Back
          </Link>
        </div>
      </header>

      <main className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-7">
        <Card>
          <SectionTitle>Profile</SectionTitle>
          <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
            <Field label="Name">
              <TextInput
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>

            <Field label="Timezone">
              <TextInput
                required
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Kolkata"
              />
            </Field>

            <p className="text-xs text-muted">
              Every reminder fires at its wall-clock time in this zone. It is never changed
              automatically — crossing a timezone for a weekend shouldn&apos;t silently rewrite
              when all your reminders go off.
            </p>

            {driftedFromDevice && (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-muted px-3.5 py-2.5">
                <p className="text-xs text-muted">
                  This device reports <span className="font-medium text-foreground">{detected}</span>
                </p>
                <button
                  type="button"
                  onClick={() => setTimezone(detected)}
                  className="shrink-0 text-xs font-medium text-accent hover:underline"
                >
                  Use it
                </button>
              </div>
            )}

            {error && <ErrorNote>{error}</ErrorNote>}
            {saved && <p className="text-xs font-medium text-success">Saved.</p>}

            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </form>
        </Card>

        <TelegramCard />

        <Card>
          <SectionTitle>Account</SectionTitle>
          <dl className="flex flex-col divide-y divide-border text-sm">
            <div className="flex justify-between gap-3 py-2.5">
              <dt className="text-muted">Email</dt>
              <dd className="truncate">{user?.email}</dd>
            </div>
            <div className="flex justify-between gap-3 py-2.5">
              <dt className="text-muted">Telegram</dt>
              <dd className="text-muted">{user?.telegramChatId ?? 'Not linked yet'}</dd>
            </div>
          </dl>
        </Card>
      </main>
    </div>
  );
}

function TelegramCard() {
  const { user, refreshUser } = useAuth();
  const [linkCode, setLinkCode] = useState<LinkCodeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linked = Boolean(user?.telegramChatId);

  async function generate() {
    setError(null);
    setBusy(true);
    try {
      setLinkCode(await apiFetch<LinkCodeResponse>('/telegram/link-code', { method: 'POST' }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Failed to generate a code');
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setError(null);
    setBusy(true);
    try {
      await apiFetch<User>('/telegram/unlink', { method: 'POST' });
      await refreshUser();
      setLinkCode(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle hint={linked ? 'Connected' : 'Not connected'}>Telegram</SectionTitle>

      {linked ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Your Telegram is connected. Send <span className="font-medium text-foreground">/goals</span>{' '}
            to the bot to see today.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button variant="subtle" onClick={unlink} disabled={busy}>
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Connect Telegram to check in from your phone — and, once the scheduler lands, to get
            nudged without opening anything.
          </p>

          {linkCode ? (
            <>
              <div className="rounded-xl border border-border bg-surface-muted px-4 py-3 text-center">
                <p className="font-mono text-2xl font-semibold tracking-[0.3em]">{linkCode.code}</p>
                <p className="mt-1 text-xs text-muted">
                  Expires in 10 minutes. Send it to the bot as{' '}
                  <span className="font-mono">/start {linkCode.code}</span>
                </p>
              </div>
              {linkCode.deepLink && (
                <a
                  href={linkCode.deepLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-contrast hover:opacity-90"
                >
                  Open in Telegram
                </a>
              )}
              {/* After linking in Telegram there's nothing to tell this tab
                  about it — the bot talked to the API, not to the browser. So
                  the user refetches themselves rather than us polling. */}
              <Button variant="subtle" onClick={refreshUser}>
                I&apos;ve sent it — check connection
              </Button>
            </>
          ) : (
            <Button onClick={generate} disabled={busy}>
              {busy ? 'Generating…' : 'Connect Telegram'}
            </Button>
          )}

          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <RequireAuth>
      <SettingsContent />
    </RequireAuth>
  );
}
