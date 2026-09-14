'use client';

import { useState, type FormEvent } from 'react';
import {
  formatTimeOfDay,
  type ScheduleBlock,
  type UpdateScheduleBlockBody,
} from '@coach/shared';
import { Button, DayPicker, ErrorNote, Field, TextInput, TimeSelect } from './ui';

export function ScheduleRow({
  block,
  onUpdate,
  onDelete,
}: {
  block: ScheduleBlock;
  onUpdate: (id: string, body: UpdateScheduleBlockBody) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  // Unlike a goal, deleting a schedule block destroys no history — it's pure
  // context. So a single click is fine here; no two-step confirm needed.
  const [busy, setBusy] = useState(false);

  if (editing) {
    return (
      <li className="rounded-xl border border-accent/40 bg-surface-muted/50 p-3.5">
        <EditForm
          block={block}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            await onUpdate(block.id, body);
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span className="truncate text-sm">{block.label}</span>
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="text-xs tabular-nums text-muted">
          {formatTimeOfDay(block.startTime)} – {formatTimeOfDay(block.endTime)}
        </span>
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-muted transition-colors hover:text-foreground"
        >
          Edit
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onDelete(block.id);
            setBusy(false);
          }}
          className="text-xs text-muted transition-colors hover:text-danger disabled:opacity-50"
          aria-label={`Remove ${block.label}`}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function EditForm({
  block,
  onSave,
  onCancel,
}: {
  block: ScheduleBlock;
  onSave: (body: UpdateScheduleBlockBody) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(block.label);
  const [startTime, setStartTime] = useState(block.startTime);
  const [endTime, setEndTime] = useState(block.endTime);
  const [days, setDays] = useState<number[]>(block.daysOfWeek);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (days.length === 0) return setError('Pick at least one day');
    setBusy(true);
    try {
      await onSave({ label, startTime, endTime, daysOfWeek: days });
    } catch {
      setError('Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Field label="What is it?">
        <TextInput required value={label} onChange={(e) => setLabel(e.target.value)} />
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
