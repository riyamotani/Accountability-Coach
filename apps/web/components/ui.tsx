'use client';

import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * Small shared primitives. Not a component library — just the handful of
 * shapes that would otherwise be copy-pasted across every page, so a visual
 * tweak happens in one place instead of eleven.
 */

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow)] ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-foreground uppercase">{children}</h2>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'subtle';
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const variants = {
    primary: 'bg-accent text-accent-contrast hover:opacity-90',
    subtle: 'bg-surface-muted text-foreground hover:bg-border',
    ghost: 'text-muted hover:text-foreground',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus-visible:outline-none ${className}`}
      {...props}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function DayPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (days: number[]) => void;
}) {
  function toggle(day: number) {
    onChange(
      value.includes(day)
        ? value.filter((d) => d !== day)
        : [...value, day].sort((a, b) => a - b),
    );
  }

  return (
    <div className="flex gap-1.5">
      {DAY_LABELS.map((label, i) => {
        const active = value.includes(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => toggle(i)}
            aria-pressed={active}
            // Screen readers would otherwise hear seven ambiguous single
            // letters ("S M T W T F S" has two S's and two T's).
            aria-label={DAY_NAMES[i]}
            className={`h-9 w-9 rounded-lg text-xs font-semibold transition-colors ${
              active
                ? 'bg-accent text-accent-contrast'
                : 'bg-surface-muted text-muted hover:text-foreground'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * We deliberately don't use <input type="time">. Its dropdown is browser
 * chrome — the hour/minute/AM-PM spinner — and cannot be styled at all, so it
 * lands in the middle of a carefully designed form looking like a different
 * application. A <select> of fixed slots is fully styleable in its closed
 * state, familiar, and keyboard-friendly.
 *
 * Tradeoff, stated plainly: 15-minute granularity. You cannot set a reminder
 * for 07:07. For a habit tracker that's a feature, not a limitation — but
 * it IS a constraint, so it's here in writing rather than buried.
 */
const TIME_SLOTS = Array.from({ length: 96 }, (_, i) => {
  const hour = Math.floor(i / 4);
  const minute = (i % 4) * 15;
  const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return { value, label: `${hour12}:${String(minute).padStart(2, '0')} ${suffix}` };
});

export function TimeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full appearance-none rounded-xl border border-border bg-surface bg-[length:16px] bg-[right_0.75rem_center] bg-no-repeat py-2.5 pr-9 pl-3.5 text-sm text-foreground"
      style={{
        // Inline SVG chevron as a data URI — `appearance: none` strips the
        // native arrow, and this keeps the replacement in one place without
        // an extra element or an icon dependency.
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2378716c' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
      }}
    >
      {TIME_SLOTS.map((slot) => (
        <option key={slot.value} value={slot.value}>
          {slot.label}
        </option>
      ))}
    </select>
  );
}

/** Progressive-disclosure wrapper so forms don't dominate the page at rest. */
export function Disclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="subtle" className="w-full" onClick={() => setOpen((o) => !o)}>
        {open ? 'Cancel' : label}
      </Button>
      {open && <div className="mt-4">{children}</div>}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted">{body}</p>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium text-danger">{children}</p>;
}
