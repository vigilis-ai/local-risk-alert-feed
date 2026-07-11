import { describe, it, expect } from 'vitest';
import { zonedIso, offsetForZone } from './timezone';

describe('zonedIso', () => {
  it('stamps a floating Pacific timestamp with the summer (PDT) offset', () => {
    expect(zonedIso('2026-07-03T14:20:00.000', 'America/Los_Angeles')).toBe(
      '2026-07-03T14:20:00-07:00'
    );
  });

  it('stamps a floating Pacific timestamp with the winter (PST) offset', () => {
    expect(zonedIso('2026-01-15T09:00:00', 'America/Los_Angeles')).toBe(
      '2026-01-15T09:00:00-08:00'
    );
  });

  it('handles the space-separated Socrata variant and Central time', () => {
    expect(zonedIso('2026-07-03 20:00:00', 'America/Chicago')).toBe(
      '2026-07-03T20:00:00-05:00'
    );
  });

  it('handles date-only input (midnight)', () => {
    expect(zonedIso('2026-07-03', 'America/Chicago')).toBe('2026-07-03T00:00:00-05:00');
  });

  it('is always accepted by strict ISO datetime parsing', () => {
    for (const s of ['2026-07-03T14:20:00.000', '2026-01-15T09:00:00', '2026-07-03']) {
      const out = zonedIso(s, 'America/Los_Angeles')!;
      // Node's Date parses offset ISO strings; a valid one round-trips to a real instant.
      expect(Number.isNaN(new Date(out).getTime())).toBe(false);
      expect(out).toMatch(/[+-]\d{2}:\d{2}$/);
    }
  });

  it('returns undefined for unparseable input', () => {
    expect(zonedIso('not a date', 'America/Los_Angeles')).toBeUndefined();
    expect(zonedIso(null, 'America/Los_Angeles')).toBeUndefined();
    expect(zonedIso(undefined, 'America/Los_Angeles')).toBeUndefined();
  });

  it('offsetForZone returns +00:00 for UTC', () => {
    expect(offsetForZone('2026-07-03T00:00:00', 'UTC')).toBe('+00:00');
  });
});
