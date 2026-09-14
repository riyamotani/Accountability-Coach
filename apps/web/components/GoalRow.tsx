'use client';

import { useState, type FormEvent } from 'react';
import {
  formatTimeOfDay,
  type Goal,
  type CheckIn,
  type UpdateGoalBody,
} from '@coach/shared';
import { Button, DayPicker, DAY_NAMES, ErrorNote, Field, TextInput, TimeSelect } from './ui';

/**
 * Last 7 days at a glance. Each dot is one day: filled if the goal was due
 * and done, hollow if due and missed, faint if it wasn't due that day at all.
 *
 * "Not due" and "missed" being visually different matters — a Mon/Wed/Fri
 * goal showing four blanks a week isn't failure, and a history strip that
 * couldn't tell those apart would make every part-time goal look broken.
 */
function HistoryDots({
  goal,
  history,
  days,
}: {
  goal: Goal;
  history: Record<string, CheckIn>;
  days: { date: string; dow: number }[];
}) {
  return (
    <div className="flex items-center gap-1" title="Last 7 days">
      {days.map(({ date, dow }) => {
        const due = goal.cadence.daysOfWeek.includes(dow);
        const status = history[`${goal.id}:${date}`]?.status;

        let className = 'bg-border';
        if (!due) className = 'bg-border/40';
        else if (status === 'done') className = 'bg-success';
        else if (status === 'partial') className = 'bg-success/50';
        else if (status === 'skipped') className = 'bg-muted/60';

        return (
          <span
            key={date}
            className={`h-2 w-2 rounded-full ${className}`}
            title={`${DAY_NAMES[dow]} ${date}${due ? ` · ${status ?? 'no check-in'}` : ' · not due'}`}
          />
        );
      })}
    </div>
  );
}

export function GoalRow({
  goal,
  history,
  days,
  onUpdate,
  onDelete,
}: {
  goal: Goal;
  history: Record<string, CheckIn>;
  days: { date: string; dow: number }[];
  onUpdate: (id: string, body: UpdateGoalBody) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  // Two-step delete instead of window.confirm — a native confirm dialog is
  // unstyleable and blocks the whole tab, and deleting a goal also deletes
  // all of its check-in history, so it deserves a deliberate second click.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (editing) {
    return (
      <li className="rounded-xl border border-accent/40 bg-surface-muted/50 p-3.5">
        <EditForm
          goal={goal}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            await onUpdate(goal.id, body);
            setEditing(false);
          }}
        />
      </li>
    );
  }

  const archived = goal.status === 'archived';

  return (
    <li className={`flex items-center justify-between gap-3 py-2.5 ${archived ? 'opacity-55' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{goal.title}</p>
          {archived && (
            <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
              Archived
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs tabular-nums text-muted">
          {goal.cadence.daysOfWeek.length === 7
            ? 'Daily'
            : goal.cadence.daysOfWeek.map((d) => DAY_NAMES[d]).join(' ')}
          {' · '}
          {formatTimeOfDay(goal.cadence.timeOfDay)}
          {goal.target ? ` · ${goal.target} ${goal.targetUnit ?? ''}` : ''}
        </p>
      </div>

      <HistoryDots goal={goal} history={history} days={days} />

      <div className="flex shrink-0 items-center gap-2.5 text-xs">
        {confirmingDelete ? (
          <>
            <button
              onClick={() => onDelete(goal.id)}
              className="font-semibold text-danger hover:underline"
            >
              Really delete?
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="text-muted hover:text-foreground"
            >
              No
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)} className="text-muted hover:text-foreground">
              Edit
            </button>
            <button
              onClick={() => onUpdate(goal.id, { status: archived ? 'active' : 'archived' })}
              className="text-muted hover:text-foreground"
            >
              {archived ? 'Restore' : 'Archive'}
            </button>
            <button
              onClick={() => setConfirmingDelete(true)}
              className="text-muted hover:text-danger"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function EditForm({
  goal,
  onSave,
  onCancel,
}: {
  goal: Goal;
  onSave: (body: UpdateGoalBody) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(goal.title);
  const [days, setDays] = useState<number[]>(goal.cadence.daysOfWeek);
  const [timeOfDay, setTimeOfDay] = useState(goal.cadence.timeOfDay);
  const [target, setTarget] = useState(goal.target?.toString() ?? '');
  const [targetUnit, setTargetUnit] = useState(goal.targetUnit ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (days.length === 0) return setError('Pick at least one day');
    setBusy(true);
    try {
      await onSave({
        title,
        cadence: { daysOfWeek: days, timeOfDay },
        ...(target ? { target: Number(target) } : {}),
        ...(targetUnit ? { targetUnit } : {}),
      });
    } catch {
      setError('Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Field label="Title">
        <TextInput required value={title} onChange={(e) => setTitle(e.target.value)} />
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
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </Field>
          <Field label="Unit">
            <TextInput value={targetUnit} onChange={(e) => setTargetUnit(e.target.value)} />
          </Field>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy} className="flex-1">
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
