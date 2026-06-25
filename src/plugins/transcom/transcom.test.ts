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

describe('TRANSCOMPlugin (pending — requires feed URL)', () => {
  it('throws without a feed URL so it cannot be silently enabled', () => {
    const prev = process.env.TRANSCOM_FEED_URL;
    delete process.env.TRANSCOM_FEED_URL;
    expect(() => new TRANSCOMPlugin()).toThrow(/feed URL is required/i);
    if (prev) process.env.TRANSCOM_FEED_URL = prev;
  });

  it('constructs once a feed URL is provided', () => {
    const p = new TRANSCOMPlugin({ feedUrl: 'https://example.org/feed' });
    expect(p.metadata.id).toBe('transcom');
  });
});
