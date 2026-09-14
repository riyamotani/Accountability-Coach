'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { RequireAuth } from '@/components/RequireAuth';
import { DayTimeline } from '@/components/DayTimeline';
import { GoalRow } from '@/components/GoalRow';
import { ScheduleRow } from '@/components/ScheduleRow';
import {
  Button,
  Card,
  DayPicker,
  DAY_NAMES,
  Disclosure,
  EmptyState,
  ErrorNote,
  Field,
  SectionTitle,
  TextInput,
  TimeSelect,
} from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { apiFetch, ApiRequestError } from '@/lib/api';
import {
  formatTimeOfDay,
  type Goal,
  type CheckIn,
  type CreateGoalBody,
  type UpdateGoalBody,
  type CheckInStatus,
  type ScheduleBlock,
  type CreateScheduleBlockBody,
  type UpdateScheduleBlockBody,
} from '@coach/shared';

/**
 * Deliberately NOT `new Date().toISOString().slice(0, 10)`. toISOString()
 * converts to UTC first, which returns the WRONG calendar day for part of
 * every day in any timezone ahead of UTC — late evening in India is already
 * "tomorrow" in UTC. The local getters keep this the day the user sees.
 */
function todayLocalDate(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function message(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError ? err.message : fallback;
}

/**
 * The last 7 calendar days, oldest first, each with its day-of-week so the
 * history strip can tell "wasn't due" apart from "missed".
 *
 * Built by stepping a Date backwards rather than subtracting milliseconds
 * from a timestamp: `setDate(n - i)` handles month boundaries, leap years,
 * and DST shifts correctly, whereas `now - i * 86400000` silently produces
 * the wrong day across a DST transition.
 */
function lastSevenDays(): { date: string; dow: number }[] {
  const out: { date: string; dow: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push({
      date: [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ].join('-'),
      dow: d.getDay(),
    });
  }
  return out;
}

function DashboardContent() {
  const { user, logout } = useAuth();
  const [goals, setGoals] = useState<Goal[]>([]);
  // Keyed "goalId:date". One flat map covers both today's buttons and the
  // 7-day history strip — the API's unique index on (goalId, date)
  // guarantees that composite key can never collide.
  const [checkIns, setCheckIns] = useState<Record<string, CheckIn>>({});
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const today = todayLocalDate();
  const todayDow = new Date().getDay();
  const [viewDay, setViewDay] = useState(todayDow);
  const days = lastSevenDays();
  const weekStart = days[0]?.date ?? today;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<Goal[]>('/goals'),
      apiFetch<CheckIn[]>(`/checkins?from=${weekStart}&to=${today}`),
      apiFetch<ScheduleBlock[]>('/schedule'),
    ])
      .then(([goalList, checkInList, blockList]) => {
        if (cancelled) return;
        setGoals(goalList);
        setCheckIns(Object.fromEntries(checkInList.map((c) => [`${c.goalId}:${c.date}`, c])));
        setBlocks(blockList);
      })
      .catch((err) => !cancelled && setError(message(err, 'Failed to load')))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [today, weekStart]);

  const markCheckIn = useCallback(
    async (goalId: string, status: CheckInStatus) => {
      try {
        const checkIn = await apiFetch<CheckIn>('/checkins', {
          method: 'PUT',
          body: JSON.stringify({ goalId, date: today, status }),
        });
        setCheckIns((prev) => ({ ...prev, [`${goalId}:${today}`]: checkIn }));
      } catch (err) {
        setError(message(err, 'Failed to update'));
      }
    },
    [today],
  );

  async function updateGoal(id: string, body: UpdateGoalBody) {
    const updated = await apiFetch<Goal>(`/goals/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    setGoals((prev) => prev.map((g) => (g.id === id ? updated : g)));
  }

  async function deleteGoal(id: string) {
    try {
      await apiFetch<void>(`/goals/${id}`, { method: 'DELETE' });
      setGoals((prev) => prev.filter((g) => g.id !== id));
      // The API cascades the goal's check-ins; mirror that locally so the
      // history strips don't keep rendering rows for a goal that's gone.
      setCheckIns((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(`${id}:`))),
      );
    } catch (err) {
      setError(message(err, 'Failed to delete goal'));
    }
  }

  async function updateBlock(id: string, body: UpdateScheduleBlockBody) {
    const updated = await apiFetch<ScheduleBlock>(`/schedule/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    setBlocks((prev) => prev.map((b) => (b.id === id ? updated : b)));
  }

  async function deleteBlock(id: string) {
    try {
      await apiFetch<void>(`/schedule/${id}`, { method: 'DELETE' });
      setBlocks((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      setError(message(err, 'Failed to remove block'));
    }
  }

  // Archived goals stop appearing in "due today" — that's the whole point of
  // archiving rather than deleting: history is preserved, nagging stops.
  const activeGoals = goals.filter((g) => g.status === 'active');
  const dueToday = activeGoals.filter((g) => g.cadence.daysOfWeek.includes(todayDow));
  const doneCount = dueToday.filter((g) => checkIns[`${g.id}:${today}`]?.status === 'done').length;
  const dayBlocks = blocks.filter((b) => b.daysOfWeek.includes(viewDay));

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-contrast">
              C
            </span>
            <div>
              <p className="text-sm font-semibold leading-tight">{user?.displayName}</p>
              <p className="text-xs leading-tight text-muted">{user?.timezone}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/settings"
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:text-foreground"
            >
              Settings
            </Link>
            <Button variant="ghost" onClick={logout}>
              Log out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-7">
        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {/* Summary strip — full width, so neither column starts with a
            lopsided hero card. */}
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="p-4!">
            <p className="text-xs font-medium tracking-wide text-muted uppercase">Done today</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {loading ? '—' : `${doneCount}/${dueToday.length}`}
            </p>
          </Card>
          <Card className="p-4!">
            <p className="text-xs font-medium tracking-wide text-muted uppercase">Active goals</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {loading ? '—' : activeGoals.length}
            </p>
          </Card>
          <Card className="p-4!">
            <p className="text-xs font-medium tracking-wide text-muted uppercase">Day</p>
            <p className="mt-1 text-2xl font-semibold">{DAY_NAMES[todayDow]}</p>
          </Card>
        </div>

        {/* Each column now owns ONE topic and its own form, instead of all
            three forms stacking on the right. */}
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-5">
            <Card>
              <SectionTitle hint={DAY_NAMES[todayDow]}>Due today</SectionTitle>
              {loading ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : dueToday.length === 0 ? (
                <EmptyState title="Nothing due today" body="Add a goal below to get started." />
              ) : (
                <ul className="flex flex-col gap-2">
                  {dueToday.map((goal) => {
                    const status = checkIns[`${goal.id}:${today}`]?.status;
                    return (
                      <li
                        key={goal.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{goal.title}</p>
                          <p className="mt-0.5 text-xs tabular-nums text-muted">
                            {formatTimeOfDay(goal.cadence.timeOfDay)}
                            {goal.target ? ` · ${goal.target} ${goal.targetUnit ?? ''}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1.5">
                          <button
                            onClick={() => markCheckIn(goal.id, 'done')}
                            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                              status === 'done'
                                ? 'bg-success text-white'
                                : 'bg-surface-muted text-muted hover:text-foreground'
                            }`}
                          >
                            Done
                          </button>
                          <button
                            onClick={() => markCheckIn(goal.id, 'skipped')}
                            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                              status === 'skipped'
                                ? 'bg-muted text-white'
                                : 'bg-surface-muted text-muted hover:text-foreground'
                            }`}
                          >
                            Skip
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card>
              <SectionTitle hint={`${goals.length} total`}>All goals</SectionTitle>
              {goals.length === 0 && !loading ? (
                <EmptyState title="No goals yet" body="Create your first one below." />
              ) : (
                <ul className="mb-4 flex flex-col divide-y divide-border">
                  {goals.map((goal) => (
                    <GoalRow
                      key={goal.id}
                      goal={goal}
                      history={checkIns}
                      days={days}
                      onUpdate={updateGoal}
                      onDelete={deleteGoal}
                    />
                  ))}
                </ul>
              )}
              <Disclosure label="+ New goal">
                <GoalForm
                  onCreate={async (body) => {
                    const goal = await apiFetch<Goal>('/goals', {
                      method: 'POST',
                      body: JSON.stringify(body),
                    });
                    setGoals((prev) => [goal, ...prev]);
                  }}
                />
              </Disclosure>
            </Card>
          </div>

          <Card>
            <SectionTitle hint="Your typical day">Schedule</SectionTitle>
            <div className="mb-4 flex gap-1">
              {DAY_NAMES.map((name, i) => (
                <button
                  key={i}
                  onClick={() => setViewDay(i)}
                  className={`flex-1 rounded-lg py-1.5 text-[11px] font-semibold transition-colors ${
                    viewDay === i
                      ? 'bg-accent text-accent-contrast'
                      : 'bg-surface-muted text-muted hover:text-foreground'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>

            <DayTimeline blocks={blocks} day={viewDay} />

            {dayBlocks.length > 0 && (
              <ul className="mt-4 flex flex-col divide-y divide-border">
                {dayBlocks.map((block) => (
                  <ScheduleRow
                    key={block.id}
                    block={block}
                    onUpdate={updateBlock}
                    onDelete={deleteBlock}
                  />
                ))}
              </ul>
            )}

            <p className="mt-4 mb-4 text-xs text-muted">
              The coach reads this to avoid suggesting times you&apos;re already busy.
            </p>

            <Disclosure label="+ Add to schedule">
              <ScheduleForm
                onCreate={async (body) => {
                  const block = await apiFetch<ScheduleBlock>('/schedule', {
                    method: 'POST',
                    body: JSON.stringify(body),
                  });
                  setBlocks((prev) => [...prev, block]);
                }}
              />
            </Disclosure>
          </Card>
        </div>
      </main>
    </div>
  );
}

function GoalForm({ onCreate }: { onCreate: (body: CreateGoalBody) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [timeOfDay, setTimeOfDay] = useState('08:00');
  const [target, setTarget] = useState('');
  const [targetUnit, setTargetUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (days.length === 0) return setError('Pick at least one day');
    setBusy(true);
    try {
      await onCreate({
        title,
        cadence: { daysOfWeek: days, timeOfDay },
        ...(target ? { target: Number(target) } : {}),
        ...(targetUnit ? { targetUnit } : {}),
      });
      setTitle('');
      setTarget('');
      setTargetUnit('');
    } catch (err) {
      setError(message(err, 'Failed to create goal'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
      <Field label="What do you want to do?">
        <TextInput
          required
          placeholder="Morning run"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label="Which days?">
        <DayPicker value={days} onChange={setDays} />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Time">
          <TimeSelect value={timeOfDay} onChange={setTimeOfDay} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Target">
            <TextInput
              type="number"
              min={0}
              placeholder="30"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </Field>
          <Field label="Unit">
            <TextInput
              placeholder="min"
              value={targetUnit}
              onChange={(e) => setTargetUnit(e.target.value)}
            />
          </Field>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" disabled={busy}>
        {busy ? 'Adding…' : 'Add goal'}
      </Button>
    </form>
  );
}

function ScheduleForm({
  onCreate,
}: {
  onCreate: (body: CreateScheduleBlockBody) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (days.length === 0) return setError('Pick at least one day');
    setBusy(true);
    try {
      await onCreate({ label, startTime, endTime, daysOfWeek: days });
      setLabel('');
    } catch (err) {
      setError(message(err, 'Failed to add block'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
      <Field label="What is it?">
        <TextInput
          required
          placeholder="Work"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="From">
          <TimeSelect value={startTime} onChange={setStartTime} />
        </Field>
        <Field label="To">
          <TimeSelect value={endTime} onChange={setEndTime} />
        </Field>
      </div>
      <Field label="Which days?">
        <DayPicker value={days} onChange={setDays} />
      </Field>
      <p className="text-xs text-muted">
        Ending before it starts means it runs past midnight — like sleep.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" disabled={busy}>
        {busy ? 'Adding…' : 'Add block'}
      </Button>
    </form>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardContent />
    </RequireAuth>
  );
}
