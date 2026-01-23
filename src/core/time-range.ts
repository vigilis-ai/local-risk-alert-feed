import type { TimeRange, TimeRangeInput, TimeRangePreset } from '../types';
import { resolveTimeRange as resolveTimeRangeUtil, resolveTimeRangePreset } from '../utils';

/**
 * Re-export time range utilities for use in core module.
 */
export const resolveTimeRange = resolveTimeRangeUtil;
export { resolveTimeRangePreset };

/**
 * Get the default time range preset.
 */
export function getDefaultTimeRangePreset(): TimeRangePreset {
  return 'next-24h';
}

/**
 * Get the default resolved time range.
 */
export function getDefaultTimeRange(): TimeRange {
  return resolveTimeRangePreset(getDefaultTimeRangePreset(), new Date());
}

/**
 * Normalize a time range input to an explicit TimeRange.
 *
 * @param input - Time range input (preset or explicit)
 * @param defaultPreset - Default preset to use if input is undefined
 * @returns Normalized TimeRange
 */
export function normalizeTimeRange(
  input?: TimeRangeInput,
  defaultPreset: TimeRangePreset = 'next-24h'
): TimeRange {
  if (!input) {
    return resolveTimeRangePreset(defaultPreset, new Date());
  }

  return resolveTimeRangeUtil(input, new Date());
}

/**
 * Get the duration of a time range in milliseconds.
 */
export function getTimeRangeDuration(range: TimeRange): number {
  return new Date(range.end).getTime() - new Date(range.start).getTime();
}

/**
 * Check if a time range is in the past.
 */
export function isTimeRangeInPast(range: TimeRange): boolean {
  return new Date(range.end).getTime() < Date.now();
}

/**
 * Check if a time range is in the future.
 */
export function isTimeRangeInFuture(range: TimeRange): boolean {
  return new Date(range.start).getTime() > Date.now();
}

/**
 * Check if a time range spans the current time.
 */
export function isTimeRangeCurrent(range: TimeRange): boolean {
  const now = Date.now();
  return new Date(range.start).getTime() <= now && new Date(range.end).getTime() >= now;
}
