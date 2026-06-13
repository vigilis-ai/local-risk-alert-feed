import type { TimeRange, TimeRangePreset, TimeRangeInput } from '../types';

/**
 * Duration constants in milliseconds.
 */
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/**
 * Upper bound on a relative window. Caller-supplied spans (e.g. "past-9999d")
 * are clamped to this so a single query can't sweep an unbounded range.
 */
export const MAX_RELATIVE_RANGE_MS = 366 * DAY_MS;

/**
 * Matches generic relative windows like "past-48h", "next-3d", "past-2w".
 * Direction is past|next; amount is a positive integer; unit is h|d|w.
 */
const RELATIVE_RANGE_RE = /^(past|next)-(\d+)(h|d|w)$/i;

const RELATIVE_UNIT_MS: Record<string, number> = {
  h: HOUR_MS,
  d: DAY_MS,
  w: WEEK_MS,
};

/**
 * Check if a string is a valid TimeRangePreset.
 */
export function isTimeRangePreset(value: string): value is TimeRangePreset {
  return [
    'past-24h',
    'past-7d',
    'past-30d',
    'next-4h',
    'next-12h',
    'next-24h',
    'next-7d',
  ].includes(value);
}

/**
 * Check if an object is a TimeRange.
 */
export function isTimeRange(value: unknown): value is TimeRange {
  return (
    typeof value === 'object' &&
    value !== null &&
    'start' in value &&
    'end' in value &&
    typeof (value as TimeRange).start === 'string' &&
    typeof (value as TimeRange).end === 'string'
  );
}

/**
 * Parse a generic relative window into an explicit TimeRange.
 *
 * Accepts `past-{n}{h|d|w}` / `next-{n}{h|d|w}` (e.g. "past-48h", "next-3d",
 * "past-2w"). This is what lets callers express arbitrary windows that aren't
 * one of the named presets — a request for "the past 48 hours" resolves here
 * instead of falling through to an undefined preset.
 *
 * @returns the resolved range, or null if the string isn't a relative window.
 */
export function parseRelativeRange(value: string, now: Date = new Date()): TimeRange | null {
  const match = RELATIVE_RANGE_RE.exec(value.trim());
  if (!match) return null;

  const direction = match[1].toLowerCase();
  const amount = Number.parseInt(match[2], 10);
  const unit = match[3].toLowerCase();
  if (!Number.isFinite(amount) || amount < 1) return null;

  const span = Math.min(amount * RELATIVE_UNIT_MS[unit], MAX_RELATIVE_RANGE_MS);
  const reference = now.getTime();

  return direction === 'past'
    ? { start: new Date(reference - span).toISOString(), end: now.toISOString() }
    : { start: now.toISOString(), end: new Date(reference + span).toISOString() };
}

/**
 * Resolve a time range input to an explicit TimeRange.
 *
 * Resilient by design — this never throws and never returns undefined. Inputs
 * are tried in order: explicit { start, end } object, named preset, generic
 * relative window (past-48h / next-3d / past-2w). Anything unrecognized falls
 * back to the default window so a stray value can't crash a downstream `.start`
 * read.
 *
 * @param input - Explicit range, preset, or relative-window string
 * @param now - Optional reference time (defaults to current time)
 * @returns Resolved TimeRange with start and end as ISO strings
 */
export function resolveTimeRange(input?: TimeRangeInput | string, now?: Date): TimeRange {
  const reference = now ?? new Date();

  // Default window when nothing is provided.
  if (!input) {
    return resolveTimeRangePreset('next-24h', reference);
  }

  // Explicit { start, end } — accept only if both dates parse, else default.
  if (isTimeRange(input)) {
    const startOk = !Number.isNaN(new Date(input.start).getTime());
    const endOk = !Number.isNaN(new Date(input.end).getTime());
    return startOk && endOk ? input : resolveTimeRangePreset('next-24h', reference);
  }

  // Named preset (past-24h, next-7d, ...).
  if (isTimeRangePreset(input)) {
    return resolveTimeRangePreset(input, reference);
  }

  // Generic relative window (past-48h, next-3d, past-2w, ...).
  const relative = parseRelativeRange(input, reference);
  if (relative) {
    return relative;
  }

  // Unrecognized input — safe default rather than undefined.
  return resolveTimeRangePreset('next-24h', reference);
}

/**
 * Resolve a TimeRangePreset to an explicit TimeRange.
 */
export function resolveTimeRangePreset(preset: TimeRangePreset, now: Date): TimeRange {
  const reference = now.getTime();

  switch (preset) {
    case 'past-24h':
      return {
        start: new Date(reference - DAY_MS).toISOString(),
        end: now.toISOString(),
      };
    case 'past-7d':
      return {
        start: new Date(reference - 7 * DAY_MS).toISOString(),
        end: now.toISOString(),
      };
    case 'past-30d':
      return {
        start: new Date(reference - 30 * DAY_MS).toISOString(),
        end: now.toISOString(),
      };
    case 'next-4h':
      return {
        start: now.toISOString(),
        end: new Date(reference + 4 * HOUR_MS).toISOString(),
      };
    case 'next-12h':
      return {
        start: now.toISOString(),
        end: new Date(reference + 12 * HOUR_MS).toISOString(),
      };
    case 'next-24h':
      return {
        start: now.toISOString(),
        end: new Date(reference + DAY_MS).toISOString(),
      };
    case 'next-7d':
      return {
        start: now.toISOString(),
        end: new Date(reference + 7 * DAY_MS).toISOString(),
      };
    // An unknown preset must never fall through to `undefined` — downstream code
    // reads `.start`/`.end` off the result. Default to the next-24h window.
    default:
      return {
        start: now.toISOString(),
        end: new Date(reference + DAY_MS).toISOString(),
      };
  }
}

/**
 * Check if a date falls within a time range.
 *
 * @param date - The date to check (string or Date)
 * @param range - The time range to check against
 * @returns true if the date falls within the range (inclusive)
 */
export function isDateInRange(date: string | Date, range: TimeRange): boolean {
  const timestamp = typeof date === 'string' ? new Date(date).getTime() : date.getTime();
  const start = new Date(range.start).getTime();
  const end = new Date(range.end).getTime();

  return timestamp >= start && timestamp <= end;
}

/**
 * Check if two time ranges overlap.
 */
export function doRangesOverlap(range1: TimeRange, range2: TimeRange): boolean {
  const start1 = new Date(range1.start).getTime();
  const end1 = new Date(range1.end).getTime();
  const start2 = new Date(range2.start).getTime();
  const end2 = new Date(range2.end).getTime();

  return start1 <= end2 && start2 <= end1;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < HOUR_MS) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  if (ms < DAY_MS) {
    return `${(ms / HOUR_MS).toFixed(1)}h`;
  }
  return `${(ms / DAY_MS).toFixed(1)}d`;
}

/**
 * Parse an ISO date string to a Date object, returning null if invalid.
 */
export function parseISODate(dateString: string): Date | null {
  const date = new Date(dateString);
  return isNaN(date.getTime()) ? null : date;
}
