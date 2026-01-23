import type { TimeRange, TimeRangePreset, TimeRangeInput } from '../types';

/**
 * Duration constants in milliseconds.
 */
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

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
 * Resolve a TimeRangeInput to an explicit TimeRange.
 *
 * @param input - Either a preset string or explicit time range
 * @param now - Optional reference time (defaults to current time)
 * @returns Resolved TimeRange with start and end as ISO strings
 */
export function resolveTimeRange(input?: TimeRangeInput, now?: Date): TimeRange {
  const reference = now ?? new Date();

  // Default to next-24h if no input provided
  if (!input) {
    return resolveTimeRangePreset('next-24h', reference);
  }

  // If it's already a TimeRange, return it
  if (isTimeRange(input)) {
    return input;
  }

  // Otherwise it's a preset
  return resolveTimeRangePreset(input, reference);
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
