import { describe, it, expect, vi, afterEach } from 'vitest';
import { ArizonaTrafficPlugin, resolveAdotIssued } from './arizona-traffic.plugin';
import { AlertAggregator } from '../../core/alert-aggregator';

// ---------------------------------------------------------------------------
// Fixtures below are verbatim property bags from the live ADOT feed
// (services6.arcgis.com/.../ADOT_Traffic_Events/FeatureServer/0), sampled
// 2026-08-25. The RADS trio is the case that must not regress: three unrelated
// city right-of-way permits, hundreds of kilometres of road apart, all carrying
// the identical `LastUpdated` of 1787624283000 — ADOT's own feed refresh time.
// ---------------------------------------------------------------------------

/** ADOT's feed-refresh stamp, shared by 1,460 of all 2,553 events that day. */
const RADS_FEED_REFRESH = 1787624283000; // 2026-08-25T02:18:03Z

const RADS_FEATURES = [
  {
    type: 'Feature' as const,
    geometry: { type: 'Point', coordinates: [-112.514352892832, 33.4356156905284] },
    properties: {
      ObjectId: 125911791,
      ID: 902105,
      SourceId: 'AZTech.Buckeye-buckeyeaz-l-100',
      Organization: 'RADS',
      RoadwayName: 'Yuma Rd',
      Description: 'Yuma Rd - road construction - Waterline install',
      Reported: 1669039200000, // 2022-11-21
      LastUpdated: RADS_FEED_REFRESH,
      StartDate: 1669039200000,
      PlannedEndDate: 1671836400000,
      EventType: 'roadwork',
      EventSubType: 'road construction',
      IsFullClosure: 0,
      Severity: '',
    },
  },
  {
    type: 'Feature' as const,
    geometry: { type: 'Point', coordinates: [-112.553310637662, 33.4212293866599] },
    properties: {
      ObjectId: 125911792,
      ID: 902106,
      SourceId: 'AZTech.Buckeye-buckeyeaz-l-101',
      Organization: 'RADS',
      RoadwayName: 'Lower buckeye Rd',
      Description: 'Lower buckeye Rd  - road construction - Boring',
      Reported: 1671778800000, // 2022-12-23
      LastUpdated: RADS_FEED_REFRESH,
      StartDate: 1671778800000,
      PlannedEndDate: 1674457200000,
      EventType: 'roadwork',
      EventSubType: 'road construction',
      IsFullClosure: 0,
      Severity: '',
    },
  },
  {
    type: 'Feature' as const,
    geometry: { type: 'Point', coordinates: [-112.586080191026, 33.3632204198786] },
    properties: {
      ObjectId: 125911793,
      ID: 902107,
      SourceId: 'AZTech.Buckeye-buckeyeaz-l-102',
      Organization: 'RADS',
      RoadwayName: 'IRWIN AVE',
      Description: 'IRWIN AVE - road construction - MANHOLE',
      Reported: 1673000000000, // 2023-01-06
      LastUpdated: RADS_FEED_REFRESH,
      StartDate: 1673000000000,
      PlannedEndDate: 1673100000000,
      EventType: 'roadwork',
      EventSubType: 'road construction',
      IsFullClosure: 0,
      Severity: '',
    },
  },
];

/** A genuine ADOT highway record — Reported is per-record and in the past. */
const US60_FEATURE = {
  type: 'Feature' as const,
  geometry: { type: 'Point', coordinates: [-111.093206945882, 33.2925650208145] },
  properties: {
    ObjectId: 125906523,
    ID: 10501,
    SourceId: '267686',
    Organization: 'ERS',
    RoadwayName: 'US-60',
    DirectionOfTravel: 'East',
    Description: 'Long term road construction on US-60 Eastbound from SR-177 (MP 227) to N Magma Mine Rd (MP 231)',
    Reported: 1729605540000, // 2024-10-22
    LastUpdated: 1787254686000,
    StartDate: 1729605540000,
    PlannedEndDate: 1844812800000,
    EventType: 'roadwork',
    EventSubType: 'longTermRoadWork',
    IsFullClosure: 0,
    Severity: 'Minor',
  },
};

/**
 * A scheduled 101-LOOP closure. RADS/ERS mirror `StartDate` into `Reported` for
 * events that have not begun, so `Reported` here is in the *future*.
 */
const LOOP101_FEATURE = {
  type: 'Feature' as const,
  geometry: { type: 'Point', coordinates: [-112.264060108999, 33.4938511989898] },
  properties: {
    ObjectId: 125911777,
    ID: 796766,
    SourceId: '382422',
    Organization: 'ERS',
    RoadwayName: '101-LOOP',
    DirectionOfTravel: 'South',
    Description: 'Bridge demolition work on 101-LOOP Southbound. All lanes closed.',
    Reported: 1790395200000, // 2026-09-25 — after the sample was taken
    LastUpdated: 1782830332000, // 2026-06-30
    StartDate: 1790395200000,
    PlannedEndDate: 1790596800000,
    EventType: 'closures',
    EventSubType: 'bridgeDemolition',
    IsFullClosure: 1,
    Severity: 'Minor',
  },
};

const NOW = 1787624400000; // 2026-08-25T02:20:00Z, just after the sampled refresh

const iso = (ms: number) => new Date(ms).toISOString();

describe('resolveAdotIssued', () => {
  it('does NOT let a shared LastUpdated collapse three distinct RADS permits', () => {
    // The regression this guards: all three carry the same LastUpdated, so the
    // old `issued: event.last_updated` gave all three the same instant.
    const issued = RADS_FEATURES.map((f) =>
      resolveAdotIssued(
        { reported: iso(f.properties.Reported), last_updated: iso(f.properties.LastUpdated) },
        NOW
      )
    );

    expect(new Set(issued).size).toBe(3);
    for (const value of issued) {
      expect(value).not.toBe(iso(RADS_FEED_REFRESH));
    }
    expect(issued[0]).toBe(iso(1669039200000));
  });

  it('reads a RADS permit as issued in 2022, not five minutes ago', () => {
    const issued = resolveAdotIssued(
      { reported: iso(1669039200000), last_updated: iso(RADS_FEED_REFRESH) },
      NOW
    );

    // The whole point: `issued` must not track the wall clock.
    expect(new Date(issued).getUTCFullYear()).toBe(2022);
    expect(NOW - Date.parse(issued)).toBeGreaterThan(1000 * 60 * 60 * 24 * 365);
  });

  it('prefers Reported on a genuine ADOT highway record too', () => {
    // ERS highway records already carry distinct LastUpdated values, so this
    // one was never broken — it must not change either.
    const { Reported, LastUpdated } = US60_FEATURE.properties;
    const issued = resolveAdotIssued(
      { reported: iso(Reported), last_updated: iso(LastUpdated) },
      NOW
    );
    expect(issued).toBe(iso(Reported));
    expect(issued).not.toBe(iso(LastUpdated));
  });

  it('keeps a future Reported rather than falling back onto the shared stamp', () => {
    // `Reported` equals `StartDate` on 100% of this feed, so scheduled work
    // carries a future value. Rejecting those as "not a publication time" was
    // tried and is worse: it hands a third of the feed back to the constant
    // LastUpdated, which is the defect, not a fix.
    const { Reported, LastUpdated } = LOOP101_FEATURE.properties;
    const issued = resolveAdotIssued(
      { reported: iso(Reported), last_updated: iso(LastUpdated) },
      NOW
    );
    expect(issued).toBe(iso(Reported));
    expect(issued).not.toBe(iso(LastUpdated));
  });

  it('falls back to LastUpdated when Reported is absent or unparseable', () => {
    expect(resolveAdotIssued({ last_updated: iso(1787254686000) }, NOW)).toBe(iso(1787254686000));
    expect(resolveAdotIssued({ reported: 'No Data', last_updated: iso(1787254686000) }, NOW)).toBe(
      iso(1787254686000)
    );
  });

  it('uses the fetch time only when the record carries no timestamp at all', () => {
    expect(resolveAdotIssued({}, NOW)).toBe(iso(NOW));
  });
});

// ---------------------------------------------------------------------------

function geojsonPage(features: unknown[], exceededTransferLimit: boolean) {
  return { type: 'FeatureCollection', properties: { exceededTransferLimit }, features };
}

function stubFetch(pages: Array<{ features: unknown[]; exceeded: boolean }>) {
  const urls: string[] = [];
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const page = pages[Math.min(call++, pages.length - 1)];
      return {
        ok: true,
        status: 200,
        json: async () => geojsonPage(page.features, page.exceeded),
      } as unknown as Response;
    })
  );
  return urls;
}

const OPTIONS = {
  location: { latitude: 33.4484, longitude: -112.074 },
  radiusMeters: 80_000,
  timeRange: { start: iso(NOW - 86_400_000), end: iso(NOW + 86_400_000) },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArizonaTrafficPlugin — issued mapping end to end', () => {
  it('gives every RADS alert its own issued timestamp', async () => {
    stubFetch([{ features: RADS_FEATURES, exceeded: false }]);

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0 });
    const result = await plugin.fetchAlerts(OPTIONS);

    expect(result.alerts).toHaveLength(3);
    const issued = result.alerts.map((a) => a.timestamps.issued);
    expect(new Set(issued).size).toBe(3);
    expect(issued).not.toContain(iso(RADS_FEED_REFRESH));
  });

  it('leaves no alert stamped with the feed refresh time, scheduled ones included', async () => {
    // The live smoke test that caught the first attempt: rejecting future
    // Reported values sent 185 of ~370 downtown alerts back to the shared
    // LastUpdated. None may carry it now.
    stubFetch([{ features: [...RADS_FEATURES, LOOP101_FEATURE], exceeded: false }]);

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    expect(alerts.length).toBe(4);
    for (const alert of alerts) {
      expect(alert.timestamps.issued).not.toBe(iso(RADS_FEED_REFRESH));
    }

    // Each alert keeps its own value rather than collapsing onto one.
    expect(new Set(alerts.map((a) => a.timestamps.issued)).size).toBe(4);

    // The scheduled closure keeps its own (future) Reported rather than the
    // shared stamp; `lastUpdatedAt` is still there for anyone who wants it.
    const loop = alerts.find((a) => a.metadata?.roadName === '101-LOOP')!;
    expect(loop.timestamps.issued).toBe(iso(LOOP101_FEATURE.properties.Reported));
    expect(loop.metadata?.lastUpdatedAt).toBe(iso(LOOP101_FEATURE.properties.LastUpdated));
  });

  it('keeps LastUpdated reachable as provenance rather than discarding it', async () => {
    stubFetch([{ features: RADS_FEATURES, exceeded: false }]);

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    expect(alerts[0].metadata?.lastUpdatedAt).toBe(iso(RADS_FEED_REFRESH));
    expect(alerts[0].metadata?.reportedAt).toBe(iso(1669039200000));
  });

  it('restores the triage tiebreak the shared stamp had flattened', async () => {
    // All three RADS permits land in the same risk band, so `issued` is the
    // only thing that can order them — exactly the tiebreak a shared
    // `LastUpdated` erased.
    stubFetch([{ features: RADS_FEATURES, exceeded: false }]);

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    const aggregator = new AlertAggregator();
    const scored = alerts
      .map((a) => ({ a, score: aggregator.scoreForTriage(a, NOW) }))
      .sort((x, y) => y.score - x.score);

    expect(new Set(alerts.map((a) => a.riskLevel)).size).toBe(1);

    // Distinct scores mean the aggregator can actually order these; identical
    // ones meant the surviving set under a result limit was arbitrary.
    expect(new Set(scored.map((s) => s.score)).size).toBe(3);

    // Most recently reported first.
    expect(scored.map((s) => s.a.metadata?.roadName)).toEqual([
      'IRWIN AVE', // reported 2023-01-06
      'Lower buckeye Rd', // reported 2022-12-23
      'Yuma Rd', // reported 2022-11-21
    ]);
  });

  it('leaves the whole set tied when scored the way the old mapping did', async () => {
    // Pins the defect itself: `issued: LastUpdated` gives one score for all
    // three, so `selectForTriage` keeps whichever happened to sort first.
    stubFetch([{ features: RADS_FEATURES, exceeded: false }]);

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0 });
    const { alerts } = await plugin.fetchAlerts(OPTIONS);

    const aggregator = new AlertAggregator();
    const oldScores = alerts.map((a) =>
      aggregator.scoreForTriage(
        { ...a, timestamps: { ...a.timestamps, issued: iso(RADS_FEED_REFRESH) } },
        NOW
      )
    );

    expect(new Set(oldScores).size).toBe(1);
  });
});

describe('ArizonaTrafficPlugin — paged fetching', () => {
  it('pages past the 2,000-record service cap instead of stopping at it', async () => {
    // Live on 2026-08-25 the feed held 2,559 events and one query returned
    // exactly 2,000 with exceededTransferLimit — 559 dropped, silently.
    const bulk = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...RADS_FEATURES[0],
        properties: {
          ...RADS_FEATURES[0].properties,
          ObjectId: offset + i,
          ID: offset + i,
          Reported: 1669039200000 + (offset + i) * 1000,
        },
      }));

    const urls = stubFetch([
      { features: bulk(1000, 0), exceeded: true },
      { features: bulk(1000, 1000), exceeded: true },
      { features: bulk(559, 2000), exceeded: false },
    ]);

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0 });
    const result = await plugin.fetchAlerts(OPTIONS);

    expect(result.alerts).toHaveLength(2559);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('resultOffset=0');
    expect(urls[1]).toContain('resultOffset=1000');
    expect(urls[2]).toContain('resultOffset=2000');
    expect(result.warnings).toBeUndefined();
  });

  it('scopes the query to the requested radius instead of the whole state', async () => {
    const urls = stubFetch([{ features: RADS_FEATURES, exceeded: false }]);

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0 });
    await plugin.fetchAlerts({ ...OPTIONS, radiusMeters: 10_000 });

    const query = decodeURIComponent(urls[0]);
    expect(query).toContain('geometryType=esriGeometryEnvelope');
    expect(query).toContain('spatialRel=esriSpatialRelIntersects');
    // Envelope must bracket the query point, not a hardcoded statewide box.
    const envelope = /geometry=([^&]+)/.exec(query)![1].split(',').map(Number);
    expect(envelope[0]).toBeLessThan(-112.074);
    expect(envelope[2]).toBeGreaterThan(-112.074);
    expect(envelope[1]).toBeLessThan(33.4484);
    expect(envelope[3]).toBeGreaterThan(33.4484);
  });

  it('warns when a cap stops the walk with records still upstream', async () => {
    const bulk = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...RADS_FEATURES[0],
        properties: { ...RADS_FEATURES[0].properties, ObjectId: offset + i, ID: offset + i },
      }));

    stubFetch([{ features: bulk(50, 0), exceeded: true }]);

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0, pageSize: 50, maxRecords: 50 });
    const result = await plugin.fetchAlerts(OPTIONS);

    // A silent truncation reads as "nothing there"; this is the whole point.
    expect(result.warnings?.join(' ')).toMatch(/more traffic events .* than the 50-record limit/);
  });

  it('reports an upstream failure instead of returning a convincing empty feed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: { code: 400, message: 'Invalid query', details: ['bad where'] } }),
      }) as unknown as Response)
    );

    const plugin = new ArizonaTrafficPlugin({ cacheTtlMs: 0 });
    const result = await plugin.fetchAlerts(OPTIONS);

    expect(result.alerts).toHaveLength(0);
    expect(result.warnings?.join(' ')).toMatch(/query failed/i);
  });
});
