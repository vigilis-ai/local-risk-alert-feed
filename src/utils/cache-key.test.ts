import { describe, it, expect } from 'vitest';
import { generateCacheKey } from './cache';

const base = {
  pluginId: 'ticketmaster-events',
  location: { latitude: 33.45, longitude: -112.02 }, // east-ish Phoenix
  timeRange: { start: '2026-07-02T00:00:00.000Z', end: '2026-07-02T06:00:00.000Z' },
  radiusMeters: 5000,
};

describe('generateCacheKey (query-exact)', () => {
  it('is stable for identical queries', () => {
    expect(generateCacheKey(base)).toBe(generateCacheKey({ ...base }));
  });

  it('differs by location (east vs west Phoenix)', () => {
    const west = { ...base, location: { latitude: 33.45, longitude: -112.29 } };
    expect(generateCacheKey(base)).not.toBe(generateCacheKey(west));
  });

  it('differs by radius', () => {
    expect(generateCacheKey(base)).not.toBe(generateCacheKey({ ...base, radiusMeters: 10000 }));
  });

  it('differs by time window even on the same day', () => {
    const wider = {
      ...base,
      timeRange: { start: '2026-07-02T00:00:00.000Z', end: '2026-07-02T23:59:59.000Z' },
    };
    expect(generateCacheKey(base)).not.toBe(generateCacheKey(wider));
  });

  it('is order-independent for filters', () => {
    const a = { ...base, categories: ['event', 'crime'], temporalTypes: ['scheduled', 'real-time'] };
    const b = { ...base, categories: ['crime', 'event'], temporalTypes: ['real-time', 'scheduled'] };
    expect(generateCacheKey(a)).toBe(generateCacheKey(b));
  });

  it('differs by filters and limit', () => {
    expect(generateCacheKey(base)).not.toBe(generateCacheKey({ ...base, categories: ['event'] }));
    expect(generateCacheKey(base)).not.toBe(generateCacheKey({ ...base, limit: 50 }));
  });

  it('honors a coarser locationPrecision for deliberate sharing', () => {
    const a = { ...base, locationPrecision: 2 };
    const b = { ...base, location: { latitude: 33.451, longitude: -112.019 }, locationPrecision: 2 };
    expect(generateCacheKey(a)).toBe(generateCacheKey(b)); // ~same at 2 decimals
  });
});
