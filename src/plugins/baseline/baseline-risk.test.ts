import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scoreCells,
  percentileToRisk,
  BaselineRiskPlugin,
  type CellStat,
  type CellSeverity,
  type BaselineSummaryMetadata,
} from './baseline-risk-plugin';
import type { PluginMetadata, GeoPoint } from '../../types';

const severityOf = (c: string) =>
  c === 'ASSAULT' ? 'violent' : c === 'THEFT' ? 'property' : 'other';

describe('scoreCells', () => {
  it('classifies categories and weights violent crime higher', () => {
    const [cell] = scoreCells(
      [{ cellId: 'A', byCategory: { ASSAULT: 2, THEFT: 5, DRUG: 1 } }],
      { severityOf, universeSize: 1 }
    );
    expect(cell.violent).toBe(2);
    expect(cell.property).toBe(5);
    expect(cell.other).toBe(1);
    expect(cell.total).toBe(8);
    expect(cell.metric).toBe(2 * 3 + 5 + 1 * 0.5); // 11.5
  });

  it('ranks percentiles across the full universe (incl. zero-incident cells)', () => {
    // 2 cells with crime, universe of 100 -> the busier cell sits near the top.
    const scored = scoreCells(
      [
        { cellId: 'low', byCategory: { THEFT: 1 } }, // metric 1
        { cellId: 'high', byCategory: { ASSAULT: 50 } }, // metric 150
      ],
      { severityOf, universeSize: 100 }
    );
    const high = scored.find((c) => c.cellId === 'high')!;
    const low = scored.find((c) => c.cellId === 'low')!;
    // 'high' is above all 98 zero cells and the 'low' cell -> ~99th pct
    expect(high.percentile).toBeGreaterThanOrEqual(98);
    // 'low' is above the 98 zero cells but below 'high' -> ~98th pct
    expect(low.percentile).toBeGreaterThanOrEqual(97);
    expect(high.percentile).toBeGreaterThan(low.percentile);
  });
});

describe('percentileToRisk', () => {
  it('maps percentile to a relative tier', () => {
    expect(percentileToRisk(99)).toBe('extreme');
    expect(percentileToRisk(92)).toBe('severe');
    expect(percentileToRisk(80)).toBe('high');
    expect(percentileToRisk(60)).toBe('moderate');
    expect(percentileToRisk(20)).toBe('low');
  });
});


// ---------------------------------------------------------------------------
// `issued` for a baseline summary.
//
// The summary describes a published dataset, so `getDatasetVersion()` — CKAN's
// `last_modified` for the Phoenix crime resource, a real ISO instant such as
// '2026-02-02T23:11:52.892262' sampled 2026-08-25 — is what "issued" means.
// Stamping the fetch time made every baseline alert look brand new, which in a
// `historical` band is both false and the strongest possible recency tiebreak.
// ---------------------------------------------------------------------------

/** Real CKAN `last_modified` from phoenixopendata.com, sampled 2026-08-25. */
const CKAN_LAST_MODIFIED = '2026-02-02T23:11:52.892262';

const NOW = Date.parse('2026-08-25T02:20:00.000Z');

class TestBaselinePlugin extends BaselineRiskPlugin {
  readonly metadata: PluginMetadata = {
    id: 'test-baseline',
    health: { expectsData: true },
    name: 'Test Baseline',
    version: '1.0.0',
    description: 'test',
    coverage: { type: 'regional', center: { latitude: 33.4484, longitude: -112.074 }, radiusMeters: 50_000, description: 'test area' },
    temporal: { supportsPast: true, supportsFuture: false, dataLagMinutes: 0, freshnessDescription: 'historical' },
    supportedTemporalTypes: ['historical'],
    supportedCategories: ['crime'],
    refreshIntervalMs: 3_600_000,
    defaultRadiusMeters: 5_000,
  };

  constructor(private readonly version: string) {
    super({ versionCheckTtlMs: 0 });
  }

  protected async getDatasetVersion(): Promise<string> {
    return this.version;
  }
  protected async materializeCells(): Promise<CellStat[]> {
    return [
      { cellId: 'A', byCategory: { ASSAULT: 12, THEFT: 30 } },
      { cellId: 'B', byCategory: { THEFT: 3 } },
    ];
  }
  protected getUniverseSize(): number {
    return 100;
  }
  protected severityOf(category: string): CellSeverity {
    return category === 'ASSAULT' ? 'violent' : 'property';
  }
  protected resolveQueryCells(): { home?: string; vicinity: string[] } {
    return { home: 'A', vicinity: ['A', 'B'] };
  }
  protected cellCentroid(): GeoPoint | undefined {
    return { latitude: 33.4484, longitude: -112.074 };
  }
  protected windowLabel(): string {
    return 'all-time since 2015';
  }
}

const QUERY = {
  location: { latitude: 33.4484, longitude: -112.074 },
  radiusMeters: 5_000,
  timeRange: { start: '2026-08-18T00:00:00.000Z', end: '2026-08-25T00:00:00.000Z' },
};

describe('BaselineRiskPlugin — issued', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the dataset publication date, not the fetch time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const { alerts } = await new TestBaselinePlugin(CKAN_LAST_MODIFIED).fetchAlerts(QUERY);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].timestamps.issued).toBe(new Date(Date.parse(CKAN_LAST_MODIFIED)).toISOString());
    expect(alerts[0].timestamps.issued).not.toBe(new Date(NOW).toISOString());
    expect((alerts[0].metadata as unknown as BaselineSummaryMetadata).issuedBasis).toBe('published');
  });

  it('falls back to the snapshot rather than the request clock for an opaque version', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const { alerts } = await new TestBaselinePlugin('unknown').fetchAlerts(QUERY);

    // Nothing parseable to anchor on, so the basis says so instead of the value
    // quietly implying a freshness the dataset never had.
    expect((alerts[0].metadata as unknown as BaselineSummaryMetadata).issuedBasis).toBe('event-start');
  });
});
