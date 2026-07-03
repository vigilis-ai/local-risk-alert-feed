import { describe, it, expect } from 'vitest';
import { AlertTimestampsSchema, AlertSourceTypeSchema, AlertLocationSchema } from './alert.schema';

describe('AlertSourceTypeSchema', () => {
  it("accepts 'traffic' (matches the AlertSourceType union)", () => {
    expect(AlertSourceTypeSchema.safeParse('traffic').success).toBe(true);
  });

  it('accepts every documented source type', () => {
    for (const t of ['police', 'fire', 'weather', 'events', 'traffic', 'other']) {
      expect(AlertSourceTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('rejects an unknown source type', () => {
    expect(AlertSourceTypeSchema.safeParse('spaceweather').success).toBe(false);
  });
});

describe('AlertLocationSchema', () => {
  it('accepts null for optional string fields and normalizes them to undefined', () => {
    const r = AlertLocationSchema.safeParse({
      point: { latitude: 40, longitude: -74 },
      city: null,
      state: null,
      address: null,
      zipCode: null,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.city).toBeUndefined();
      expect(r.data.state).toBeUndefined();
    }
  });

  it('still accepts populated strings and omitted fields', () => {
    const r = AlertLocationSchema.safeParse({
      point: { latitude: 40, longitude: -74 },
      city: 'New York',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.city).toBe('New York');
  });
});

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
