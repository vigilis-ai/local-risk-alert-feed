import { describe, it, expect, vi, afterEach } from 'vitest';
import { GlendaleEventsPlugin } from './glendale-events.plugin';

const NOW = Date.parse('2026-08-25T02:20:00.000Z');

const OPTIONS = {
  location: { latitude: 33.534, longitude: -112.234 },
  radiusMeters: 10_000,
  timeRange: { start: '2026-08-25T00:00:00.000Z', end: '2026-12-31T00:00:00.000Z' },
};

/**
 * Ticketmaster Discovery API shape, State Farm Stadium / Desert Diamond Arena.
 * `sales.public.startDateTime` is the per-event onsale instant.
 */
const TM_EVENTS = [
  {
    id: 'vvG1zZ9Qk1GlnA',
    name: 'Arizona Cardinals vs. Seattle Seahawks',
    type: 'event',
    url: 'https://www.ticketmaster.com/event/vvG1zZ9Qk1GlnA',
    dates: {
      start: { localDate: '2026-09-13', localTime: '13:25:00', dateTime: '2026-09-13T20:25:00Z' },
      status: { code: 'onsale' },
    },
    sales: { public: { startDateTime: '2026-05-15T15:00:00Z' } },
    classifications: [{ segment: { name: 'Sports' }, genre: { name: 'Football' } }],
    _embedded: {
      venues: [
        {
          name: 'State Farm Stadium',
          address: { line1: '1 Cardinals Drive' },
          city: { name: 'Glendale' },
          state: { stateCode: 'AZ' },
          postalCode: '85305',
          location: { latitude: '33.5276', longitude: '-112.2626' },
        },
      ],
    },
  },
  {
    id: 'vvG1zZ9Qk1GlnB',
    name: 'Desert Diamond Arena Concert',
    type: 'event',
    url: 'https://www.ticketmaster.com/event/vvG1zZ9Qk1GlnB',
    dates: {
      start: { localDate: '2026-10-10', localTime: '20:00:00', dateTime: '2026-10-11T03:00:00Z' },
      status: { code: 'onsale' },
    },
    sales: { public: { startDateTime: '2026-06-20T17:00:00Z' } },
    classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' } }],
    _embedded: {
      venues: [
        {
          name: 'Desert Diamond Arena',
          city: { name: 'Glendale' },
          state: { stateCode: 'AZ' },
          location: { latitude: '33.5319', longitude: '-112.2611' },
        },
      ],
    },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GlendaleEventsPlugin — issued', () => {
  it('uses the onsale date instead of stamping the fetch time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: true, status: 200, json: async () => ({ _embedded: { events: TM_EVENTS } }) }) as unknown as Response
      )
    );

    const plugin = new GlendaleEventsPlugin({ ticketmasterApiKey: 'test-key', cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.timestamps.issued)).toEqual([
      '2026-05-15T15:00:00.000Z',
      '2026-06-20T17:00:00.000Z',
    ]);
    for (const alert of alerts) {
      expect(alert.metadata?.issuedBasis).toBe('published');
      expect(alert.timestamps.issued).not.toBe(new Date(NOW).toISOString());
    }
  });
});
