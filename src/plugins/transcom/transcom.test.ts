import { describe, it, expect } from 'vitest';
import { mapTranscomSeverity, TRANSCOMPlugin } from './transcom.plugin';

describe('mapTranscomSeverity', () => {
  it('maps word severities', () => {
    expect(mapTranscomSeverity('Severe')).toBe('severe');
    expect(mapTranscomSeverity('Major')).toBe('severe');
    expect(mapTranscomSeverity('High')).toBe('high');
    expect(mapTranscomSeverity('Moderate')).toBe('moderate');
    expect(mapTranscomSeverity('Minor')).toBe('low');
  });

  it('maps numeric severities', () => {
    expect(mapTranscomSeverity('4')).toBe('severe');
    expect(mapTranscomSeverity('1')).toBe('low');
  });

  it('defaults to moderate for unknown/missing', () => {
    expect(mapTranscomSeverity(undefined)).toBe('moderate');
    expect(mapTranscomSeverity('')).toBe('moderate');
  });
});

describe('TRANSCOMPlugin (registerable while disabled)', () => {
  it('constructs without a feed URL and reports disabled (does not throw)', () => {
    const prev = process.env.TRANSCOM_FEED_URL;
    delete process.env.TRANSCOM_FEED_URL;
    const p = new TRANSCOMPlugin();
    expect(p.configured).toBe(false);
    expect(p.enabled).toBe(false);
    if (prev) process.env.TRANSCOM_FEED_URL = prev;
  });

  it('returns no alerts and a disabled warning when not configured', async () => {
    const prev = process.env.TRANSCOM_FEED_URL;
    delete process.env.TRANSCOM_FEED_URL;
    const p = new TRANSCOMPlugin();
    const res = await p.fetchAlerts({
      location: { latitude: 40.73, longitude: -73.99 },
      radiusMeters: 10000,
      timeRange: { start: new Date().toISOString(), end: new Date().toISOString() },
    } as Parameters<TRANSCOMPlugin['fetchAlerts']>[0]);
    expect(res.alerts).toEqual([]);
    expect(res.warnings?.[0]).toMatch(/disabled/i);
    if (prev) process.env.TRANSCOM_FEED_URL = prev;
  });

  it('is enabled once a feed URL is provided', () => {
    const p = new TRANSCOMPlugin({ feedUrl: 'https://example.org/feed' });
    expect(p.configured).toBe(true);
    expect(p.metadata.id).toBe('transcom');
  });
});
