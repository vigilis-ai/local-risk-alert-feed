import { describe, it, expect, vi, afterEach } from 'vitest';
import { AustinEventsPlugin } from './austin-events.plugin';

const NOW = Date.parse('2026-08-25T02:20:00.000Z');

const OPTIONS = {
  location: { latitude: 30.2672, longitude: -97.7431 },
  radiusMeters: 25_000,
  // Wide enough to keep both real permits below; the plugin filters on the
  // event window, and one of these fixtures is a genuine 2019 record.
  timeRange: { start: '2019-01-01T00:00:00.000Z', end: '2026-12-31T00:00:00.000Z' },
};

// ---------------------------------------------------------------------------
// Verbatim rows from data.austintexas.gov, sampled 2026-08-25.
//
// `teth-r7k8` (special-event permits) carries `report_date` — a real per-permit
// stamp, 24 distinct values across 2,000 sampled rows. Its Socrata `:updated_at`
// is the trap: exactly ONE value across all 2,000 rows, i.e. a bulk-republish
// stamp, the same failure mode as ADOT's `LastUpdated`.
//
// `p9ma-z6y9` (convention centre listings) carries no per-record timestamp at
// all — one `:updated_at` across all 80 rows.
// ---------------------------------------------------------------------------

const SPECIAL_EVENTS = [
  {
    folderrsn: '13561137',
    foldertype: 'SE',
    foldername: '2025 Corazón Latino: A Celebration of Heritage',
    status: 'Active',
    tier_type: '3',
    event_applicant_organization: 'US Hispanic Contractors Association',
    start_date: 'September 27, 2025 10:00',
    end_date: 'September 27, 2025 22:00',
    event_length: '1',
    event_setup: 'Sep 26, 2025',
    event_teardown: 'Sep 29, 2025',
    amplified_sound: 'Yes',
    alcohol_served: 'Yes',
    report_date: '20251126000000',
    road_closure: '1900-2129 E 4TH ST',
    type_of_road_closure: 'Closure : Full Road',
    gpslatitude: '30.25955133',
    gpslongitude: '-97.72259433',
  },
  {
    folderrsn: '12264349',
    foldertype: 'SE',
    foldername: '2019 In Light',
    status: 'Active',
    tier_type: '3',
    event_applicant_organization: 'Blue Lapis Light Inc.',
    start_date: 'August 02, 2019 18:00',
    end_date: 'September 29, 2019 22:00',
    event_length: '59',
    amplified_sound: 'Yes',
    alcohol_served: 'No',
    report_date: '20191128000000',
    road_closure: '500-517 SAN ANTONIO ST',
    type_of_road_closure: 'Closure : Full Road',
    gpslatitude: '30.26862',
    gpslongitude: '-97.75119',
  },
];

const CONVENTION_EVENTS = [
  {
    arrive_date: '2026-08-01T00:00:00.000',
    depart_date: '2026-08-01T00:00:00.000',
    location: 'Palmer Events Center',
    event_name: 'IMPORTEXPO CAR SHOW',
  },
  {
    arrive_date: '2026-08-04T00:00:00.000',
    depart_date: '2026-08-05T00:00:00.000',
    location: 'Palmer Events Center',
    event_name: 'Food Truck Owners Expo',
    website: 'https://www.ftoexpo.com/',
  },
];

/** Route each Socrata dataset to its own fixture by resource id in the URL. */
function stubAustin() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const payload = url.includes('teth-r7k8') ? SPECIAL_EVENTS : CONVENTION_EVENTS;
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AustinEventsPlugin — issued', () => {
  it('reads a permit as issued on its report_date, not at fetch time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubAustin();

    const plugin = new AustinEventsPlugin({ includeConventionEvents: false, cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    const corazon = alerts.find((a) => a.source.externalId === '13561137')!;
    expect(corazon.timestamps.issued).toBe('2025-11-26T00:00:00.000Z');
    expect(corazon.metadata?.issuedBasis).toBe('published');
    expect(corazon.metadata?.reportedAt).toBe('2025-11-26T00:00:00.000Z');

    const inLight = alerts.find((a) => a.source.externalId === '12264349')!;
    expect(inLight.timestamps.issued).toBe('2019-11-28T00:00:00.000Z');

    expect(new Set(alerts.map((a) => a.timestamps.issued)).size).toBe(alerts.length);
    for (const alert of alerts) {
      expect(alert.timestamps.issued).not.toBe(new Date(NOW).toISOString());
    }
  });

  it('anchors convention listings on the arrival date the feed does publish', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubAustin();

    const plugin = new AustinEventsPlugin({ includeSpecialEvents: false, cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert.metadata?.issuedBasis).toBe('event-start');
      expect(alert.timestamps.issued).not.toBe(new Date(NOW).toISOString());
    }
    expect(new Set(alerts.map((a) => a.timestamps.issued)).size).toBe(alerts.length);
  });
});
