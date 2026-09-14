'use client';

import type { ScheduleBlock } from '@coach/shared';

/** "09:30" -> 570. The only time arithmetic in this file works in minutes. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const MINUTES_PER_DAY = 1440;

/**
 * Stable per-label colour: same label always gets the same hue, without
 * storing a colour on the record. A tiny string hash into a fixed palette —
 * deterministic, so "Work" doesn't change colour between reloads.
 */
const PALETTE = [
  'bg-[#6d5cff]/85',
  'bg-[#0ea5e9]/85',
  'bg-[#f59e0b]/85',
  'bg-[#ec4899]/85',
  'bg-[#10b981]/85',
  'bg-[#8b5cf6]/85',
];

function colorFor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? PALETTE[0]!;
}

interface Segment {
  block: ScheduleBlock;
  startMin: number;
  endMin: number;
}

/**
 * A block that wraps past midnight (sleep 23:00->07:00) can't be drawn as one
 * rectangle on a 00:00-24:00 axis, so it becomes two segments: one running to
 * the bottom of the day, one from the top. This is the only place the wrap
 * rule from the ScheduleBlock type needs handling.
 */
function toSegments(blocks: ScheduleBlock[], day: number): Segment[] {
  const segments: Segment[] = [];
  for (const block of blocks) {
    if (!block.daysOfWeek.includes(day)) continue;
    const start = toMinutes(block.startTime);
    const end = toMinutes(block.endTime);
    if (end > start) {
      segments.push({ block, startMin: start, endMin: end });
    } else {
      segments.push({ block, startMin: start, endMin: MINUTES_PER_DAY });
      if (end > 0) segments.push({ block, startMin: 0, endMin: end });
    }
  }
  return segments;
}

export function DayTimeline({ blocks, day }: { blocks: ScheduleBlock[]; day: number }) {
  const segments = toSegments(blocks, day);
  const hourMarks = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  return (
    <div className="flex gap-3">
      {/* Hour gutter */}
      <div className="relative w-10 shrink-0" style={{ height: 480 }}>
        {hourMarks.map((h) => (
          <span
            key={h}
            className="absolute right-0 -translate-y-1/2 text-[10px] tabular-nums text-muted"
            style={{ top: `${(h / 24) * 100}%` }}
          >
            {String(h).padStart(2, '0')}:00
          </span>
        ))}
      </div>

      {/* Track */}
      <div
        className="relative flex-1 overflow-hidden rounded-xl border border-border bg-surface-muted"
        style={{ height: 480 }}
      >
        {hourMarks.slice(1, -1).map((h) => (
          <div
            key={h}
            className="absolute inset-x-0 border-t border-border/70"
            style={{ top: `${(h / 24) * 100}%` }}
          />
        ))}

        {segments.map((seg, i) => {
          const top = (seg.startMin / MINUTES_PER_DAY) * 100;
          const height = ((seg.endMin - seg.startMin) / MINUTES_PER_DAY) * 100;
          return (
            <div
              key={`${seg.block.id}-${i}`}
              className={`absolute inset-x-1.5 overflow-hidden rounded-lg px-2.5 py-1 text-white ${colorFor(
                seg.block.label,
              )}`}
              style={{ top: `${top}%`, height: `${height}%` }}
              title={`${seg.block.label} · ${seg.block.startTime}–${seg.block.endTime}`}
            >
              <p className="truncate text-xs font-semibold leading-tight">{seg.block.label}</p>
              {/* Only label very short blocks with a time if there's room for it */}
              {height > 5 && (
                <p className="truncate text-[10px] tabular-nums opacity-90">
                  {seg.block.startTime}–{seg.block.endTime}
                </p>
              )}
            </div>
          );
        })}

        {segments.length === 0 && (
          <p className="absolute inset-0 grid place-items-center text-xs text-muted">
            Nothing scheduled this day
          </p>
        )}
      </div>
    </div>
  );
}
