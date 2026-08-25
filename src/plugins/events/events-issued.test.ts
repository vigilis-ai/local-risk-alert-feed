import { describe, it, expect, vi, afterEach } from 'vitest';
import { PhoenixEventsPlugin } from './phoenix-events.plugin';
import { PhoenixConventionCenterPlugin } from './phoenix-convention-center.plugin';
import { AlertAggregator } from '../../core/alert-aggregator';

const NOW = Date.parse('2026-08-25T02:20:00.000Z');

const OPTIONS = {
  location: { latitude: 33.4484, longitude: -112.074 },
  radiusMeters: 25_000,
  timeRange: { start: '2026-08-25T00:00:00.000Z', end: '2026-11-25T00:00:00.000Z' },
};

function stubJson(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response)
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Ticketmaster Discovery API `/discovery/v2/events`. Shape per the published
// schema: each event carries `sales.public.startDateTime` (the onsale instant),
// which is per-event and in the past for anything currently listed.
// ---------------------------------------------------------------------------

const TM_EVENTS = [
  {
    id: 'vvG1zZ9Qk1AbCd',
    name: 'Arizona Diamondbacks vs. Los Angeles Dodgers',
    type: 'event',
    url: 'https://www.ticketmaster.com/event/vvG1zZ9Qk1AbCd',
    dates: {
      start: { localDate: '2026-09-04', localTime: '18:40:00', dateTime: '2026-09-05T01:40:00Z' },
      status: { code: 'onsale' },
    },
    sales: { public: { startDateTime: '2026-03-14T15:00:00Z' } },
    classifications: [{ segment: { name: 'Sports' }, genre: { name: 'Baseball' } }],
    _embedded: {
      venues: [
        {
          name: 'Chase Field',
          address: { line1: '401 East Jefferson Street' },
          city: { name: 'Phoenix' },
          state: { stateCode: 'AZ' },
          postalCode: '85004',
          location: { latitude: '33.445526', longitude: '-112.066721' },
        },
      ],
    },
  },
  {
    id: 'vvG1zZ9Qk1EfGh',
    name: 'Suns vs. Warriors',
    type: 'event',
    url: 'https://www.ticketmaster.com/event/vvG1zZ9Qk1EfGh',
    dates: {
      start: { localDate: '2026-10-22', localTime: '19:00:00', dateTime: '2026-10-23T02:00:00Z' },
      status: { code: 'onsale' },
    },
    sales: { public: { startDateTime: '2026-07-30T17:00:00Z' } },
    classifications: [{ segment: { name: 'Sports' }, genre: { name: 'Basketball' } }],
    _embedded: {
      venues: [
        {
          name: 'Footprint Center',
          address: { line1: '201 East Jefferson Street' },
          city: { name: 'Phoenix' },
          state: { stateCode: 'AZ' },
          postalCode: '85004',
          location: { latitude: '33.445833', longitude: '-112.071389' },
        },
      ],
    },
  },
  {
    // Announced but not yet on sale: the onsale date is in the FUTURE, so it is
    // not a publication time and must not be used as one.
    id: 'vvG1zZ9Qk1IjKl',
    name: 'Presale Announcement Show',
    type: 'event',
    url: 'https://www.ticketmaster.com/event/vvG1zZ9Qk1IjKl',
    dates: {
      start: { localDate: '2026-12-31', localTime: '20:00:00', dateTime: '2027-01-01T03:00:00Z' },
      status: { code: 'onsale' },
    },
    sales: { public: { startDateTime: '2026-11-01T17:00:00Z' } },
    classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' } }],
    _embedded: {
      venues: [
        {
          name: 'Footprint Center',
          city: { name: 'Phoenix' },
          state: { stateCode: 'AZ' },
          location: { latitude: '33.445833', longitude: '-112.071389' },
        },
      ],
    },
  },
];

describe('PhoenixEventsPlugin — issued', () => {
  it('uses the per-event onsale date instead of the fetch time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubJson({ _embedded: { events: TM_EVENTS } });

    const plugin = new PhoenixEventsPlugin({ ticketmasterApiKey: 'test-key', cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    expect(alerts).toHaveLength(3);

    const dbacks = alerts.find((a) => a.source.externalId === 'vvG1zZ9Qk1AbCd')!;
    expect(dbacks.timestamps.issued).toBe('2026-03-14T15:00:00.000Z');
    expect(dbacks.metadata?.issuedBasis).toBe('published');

    // No alert may claim it was issued at the moment we asked for it.
    for (const alert of alerts) {
      expect(alert.timestamps.issued).not.toBe(new Date(NOW).toISOString());
    }
  });

  it('falls back to the event date when tickets are not on sale yet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubJson({ _embedded: { events: TM_EVENTS } });

    const plugin = new PhoenixEventsPlugin({ ticketmasterApiKey: 'test-key', cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    const presale = alerts.find((a) => a.source.externalId === 'vvG1zZ9Qk1IjKl')!;
    expect(presale.metadata?.issuedBasis).toBe('event-start');
    expect(presale.timestamps.issued).toBe('2027-01-01T03:00:00.000Z');
  });

  it('gives the aggregator something to rank on', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubJson({ _embedded: { events: TM_EVENTS } });

    const plugin = new PhoenixEventsPlugin({ ticketmasterApiKey: 'test-key', cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    const aggregator = new AlertAggregator();
    const issued = alerts.map((a) => a.timestamps.issued);
    expect(new Set(issued).size).toBe(3);

    // Under the old mapping all three were `now()`, so all three scored
    // identically and the result limit kept an arbitrary subset.
    const oldScores = alerts.map((a) =>
      aggregator.scoreForTriage(
        { ...a, timestamps: { ...a.timestamps, issued: new Date(NOW).toISOString() } },
        NOW
      )
    );
    expect(new Set(oldScores).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phoenix Convention Center (Ungerboeck). Verbatim records from
// phoenixcc-web.ungerboeck.com/.../events/getall?orgcode=01, sampled
// 2026-08-25. Note what is NOT here: any created/updated field at all.
// ---------------------------------------------------------------------------

const PCC_EVENTS = [
  {
    id: '36206',
    title: 'FOTOT & DTPHX Inc Present: Spaceballs (1987)',
    start: '2026-09-01T16:01:00',
    end: '2026-09-01T23:59:00',
    start_date_formatted: '09-01-2026',
    end_date_formatted: '09-01-2026',
    start_date_week_formatted: 'Tuesday',
    end_date_week_formatted: 'Tuesday',
    start_time: '4:01 PM',
    end_time: '11:59 PM',
    allDay: 'False',
    location_override: '',
    event_notes_description: '',
    event_url: 'https://www.etix.com/ticket/p/50255769/',
    event_type: 'O',
    func_ID: '2',
  },
  {
    id: '33958',
    title: 'Arizona Grand Gala of Stars',
    start: '2026-09-05T07:01:00',
    end: '2026-09-05T23:59:00',
    start_date_formatted: '09-05-2026',
    end_date_formatted: '09-05-2026',
    start_date_week_formatted: 'Saturday',
    end_date_week_formatted: 'Saturday',
    start_time: '7:01 AM',
    end_time: '11:59 PM',
    allDay: 'False',
    location_override: '',
    event_notes_description: '',
    event_url: '',
    event_type: 'S',
    func_ID: '2',
  },
];

describe('PhoenixConventionCenterPlugin — issued', () => {
  it('anchors on the event date because the feed publishes no timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubJson(PCC_EVENTS);

    const plugin = new PhoenixConventionCenterPlugin({ cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    expect(alerts).toHaveLength(2);
    for (const alert of alerts) {
      expect(alert.metadata?.issuedBasis).toBe('event-start');
      expect(alert.timestamps.issued).not.toBe(new Date(NOW).toISOString());
      expect(alert.timestamps.issued).toBe(new Date(alert.timestamps.eventStart!).toISOString());
    }

    // Distinct events keep distinct values rather than collapsing to one.
    expect(new Set(alerts.map((a) => a.timestamps.issued)).size).toBe(2);
  });
});
