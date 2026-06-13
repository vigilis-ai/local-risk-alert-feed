import { describe, it, expect } from 'vitest';
import {
  HOUR_MS,
  DAY_MS,
  WEEK_MS,
  MAX_RELATIVE_RANGE_MS,
  parseRelativeRange,
  resolveTimeRange,
  resolveTimeRangePreset,
} from './date';

const NOW = new Date('2026-06-13T12:00:00.000Z');
const spanMs = (r: { start: string; end: string }) =>
  new Date(r.end).getTime() - new Date(r.start).getTime();

describe('parseRelativeRange', () => {
  it('parses "past-48h" — the window that used to crash the alert tool', () => {
    const r = parseRelativeRange('past-48h', NOW);
    expect(r).not.toBeNull();
    expect(r!.end).toBe(NOW.toISOString());
    expect(spanMs(r!)).toBe(48 * HOUR_MS);
    expect(new Date(r!.start).toISOString()).toBe('2026-06-11T12:00:00.000Z');
  });

  it('parses days, weeks, and future windows', () => {
    expect(spanMs(parseRelativeRange('past-3d', NOW)!)).toBe(3 * DAY_MS);
    expect(spanMs(parseRelativeRange('past-2w', NOW)!)).toBe(2 * WEEK_MS);

    const next = parseRelativeRange('next-6h', NOW)!;
    expect(next.start).toBe(NOW.toISOString());
    expect(spanMs(next)).toBe(6 * HOUR_MS);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(spanMs(parseRelativeRange('PAST-48H', NOW)!)).toBe(48 * HOUR_MS);
    expect(spanMs(parseRelativeRange('  past-48h  ', NOW)!)).toBe(48 * HOUR_MS);
  });

  it('clamps absurd spans to the maximum', () => {
    expect(spanMs(parseRelativeRange('past-9999d', NOW)!)).toBe(MAX_RELATIVE_RANGE_MS);
  });

  it('returns null for non-relative strings and zero/negative amounts', () => {
    expect(parseRelativeRange('past-24h', NOW)).not.toBeNull(); // valid preset is also a valid relative form
    expect(parseRelativeRange('past-0h', NOW)).toBeNull();
    expect(parseRelativeRange('yesterday', NOW)).toBeNull();
    expect(parseRelativeRange('past-48', NOW)).toBeNull();
    expect(parseRelativeRange('48h', NOW)).toBeNull();
  });
});

describe('resolveTimeRange', () => {
  it('resolves named presets', () => {
    expect(spanMs(resolveTimeRange('past-7d', NOW))).toBe(7 * DAY_MS);
    expect(spanMs(resolveTimeRange('next-24h', NOW))).toBe(DAY_MS);
  });

  it('resolves generic relative windows that are not presets', () => {
    const r = resolveTimeRange('past-48h', NOW);
    expect(spanMs(r)).toBe(48 * HOUR_MS);
    expect(r.end).toBe(NOW.toISOString());
  });

  it('passes through valid explicit ranges and rejects malformed ones', () => {
    const explicit = { start: '2026-06-01T00:00:00.000Z', end: '2026-06-02T00:00:00.000Z' };
    expect(resolveTimeRange(explicit, NOW)).toEqual(explicit);

    // Malformed dates must not propagate — fall back to a valid default window.
    const bad = { start: 'not-a-date', end: 'also-bad' } as unknown as typeof explicit;
    const fallback = resolveTimeRange(bad, NOW);
    expect(Number.isNaN(new Date(fallback.start).getTime())).toBe(false);
  });

  it('falls back to a valid window for unknown input instead of returning undefined', () => {
    const r = resolveTimeRange('past-3-fortnights' as never, NOW);
    expect(r).toBeDefined();
    expect(typeof r.start).toBe('string');
    expect(typeof r.end).toBe('string');
  });

  it('defaults when no input is given', () => {
    expect(spanMs(resolveTimeRange(undefined, NOW))).toBe(DAY_MS);
  });
});

describe('resolveTimeRangePreset', () => {
  it('never returns undefined for an unknown preset (regression: reading .start of undefined)', () => {
    // Simulates the original prod crash input that bypassed the switch.
    const r = resolveTimeRangePreset('past-48h' as never, NOW);
    expect(r).toBeDefined();
    expect(() => r.start).not.toThrow();
    expect(typeof r.start).toBe('string');
  });
});
