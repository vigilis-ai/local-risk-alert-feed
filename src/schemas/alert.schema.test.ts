import { describe, it, expect } from 'vitest';
import { AlertTimestampsSchema } from './alert.schema';

describe('AlertTimestampsSchema', () => {
  it('accepts ISO timestamps with a timezone offset (e.g. NWS "…-04:00")', () => {
    const r = AlertTimestampsSchema.safeParse({
      issued: '2026-07-03T14:00:00-04:00',
      eventStart: '2026-07-03T14:00:00-04:00',
      expires: '2026-07-03T18:00:00-04:00',
    });
    expect(r.success).toBe(true);
  });

  it('still accepts UTC "Z" timestamps', () => {
    const r = AlertTimestampsSchema.safeParse({ issued: '2026-07-03T18:00:00Z' });
    expect(r.success).toBe(true);
  });

  it('accepts null for open-ended alerts and normalizes it to undefined', () => {
    const r = AlertTimestampsSchema.safeParse({
      issued: '2026-07-03T18:00:00Z',
      eventEnd: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.eventEnd).toBeUndefined();
  });

  it('allows optional fields to be omitted entirely', () => {
    const r = AlertTimestampsSchema.safeParse({ issued: '2026-07-03T18:00:00Z' });
    expect(r.success).toBe(true);
  });

  it('rejects a non-datetime string', () => {
    const r = AlertTimestampsSchema.safeParse({ issued: 'not-a-date' });
    expect(r.success).toBe(false);
  });

  it('rejects a missing required "issued"', () => {
    const r = AlertTimestampsSchema.safeParse({ expires: '2026-07-03T18:00:00Z' });
    expect(r.success).toBe(false);
  });
});
