import { describe, it, expect } from 'vitest';
import { resolveIssued, parseSocrataNumericDate } from './issued';

const NOW = Date.parse('2026-08-25T02:20:00.000Z');
const iso = (s: string) => new Date(Date.parse(s)).toISOString();

describe('resolveIssued', () => {
  it('takes the first usable publication timestamp', () => {
    expect(
      resolveIssued({ published: ['2026-07-01T12:00:00Z'], eventStart: '2026-09-01', now: NOW })
    ).toEqual({ issued: iso('2026-07-01T12:00:00Z'), basis: 'published' });
  });

  it('skips a published candidate it cannot parse and tries the next', () => {
    expect(
      resolveIssued({ published: ['', 'TBD', '2026-06-15T00:00:00Z'], now: NOW }).issued
    ).toBe(iso('2026-06-15T00:00:00Z'));
  });

  it('rejects a future publication date — an unopened onsale is not a publish', () => {
    // Ticketmaster lists events before tickets go on sale; that onsale date
    // says nothing about when the record was published.
    const r = resolveIssued({
      published: ['2026-12-01T10:00:00Z'],
      eventStart: '2027-01-15T02:00:00Z',
      now: NOW,
    });
    expect(r.basis).toBe('event-start');
    expect(r.issued).toBe(iso('2027-01-15T02:00:00Z'));
  });

  it('falls back to the event date rather than stamping the fetch time', () => {
    const r = resolveIssued({ eventStart: '2026-09-04T00:00:00.000', now: NOW });
    expect(r.basis).toBe('event-start');
    expect(r.issued).not.toBe(new Date(NOW).toISOString());
  });

  it('keeps distinct event dates distinct, so the tiebreak still has something to sort on', () => {
    const issued = ['2026-09-01', '2026-09-04', '2026-09-11'].map(
      (d) => resolveIssued({ eventStart: d, now: NOW }).issued
    );
    expect(new Set(issued).size).toBe(3);
  });

  it('uses the fetch time only as a last resort, and says so', () => {
    expect(resolveIssued({ now: NOW })).toEqual({
      issued: new Date(NOW).toISOString(),
      basis: 'fetch-time',
    });
    expect(resolveIssued({ published: [null, undefined], eventStart: 'not a date', now: NOW }).basis).toBe(
      'fetch-time'
    );
  });

  it('accepts epoch millis and Date objects as well as strings', () => {
    expect(resolveIssued({ published: [1729605540000], now: NOW }).issued).toBe(
      new Date(1729605540000).toISOString()
    );
    expect(resolveIssued({ published: [new Date(1729605540000)], now: NOW }).issued).toBe(
      new Date(1729605540000).toISOString()
    );
  });
});

describe('parseSocrataNumericDate', () => {
  it('parses the real Austin permit shape', () => {
    // Verbatim `report_date` from data.austintexas.gov/resource/teth-r7k8.
    expect(parseSocrataNumericDate('20191128000000')).toBe('2019-11-28T00:00:00.000Z');
    expect(parseSocrataNumericDate('20200127000000')).toBe('2020-01-27T00:00:00.000Z');
    expect(parseSocrataNumericDate('20190915193027')).toBe('2019-09-15T19:30:27.000Z');
  });

  it('accepts a date-only value', () => {
    expect(parseSocrataNumericDate('20191128')).toBe('2019-11-28T00:00:00.000Z');
  });

  it('returns undefined rather than a silently rolled-over date', () => {
    // Date.UTC would turn month 13 into the next January.
    expect(parseSocrataNumericDate('20191345000000')).toBeUndefined();
    expect(parseSocrataNumericDate('20190231000000')).toBeUndefined();
  });

  it('returns undefined for junk and empty input', () => {
    expect(parseSocrataNumericDate('')).toBeUndefined();
    expect(parseSocrataNumericDate('Nov 28, 2019')).toBeUndefined();
    expect(parseSocrataNumericDate(null)).toBeUndefined();
    expect(parseSocrataNumericDate(undefined)).toBeUndefined();
  });
});
