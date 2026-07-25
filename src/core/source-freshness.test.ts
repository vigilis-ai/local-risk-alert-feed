import { describe, it, expect } from 'vitest';
import { AlertFeed } from './alert-feed';
import type {
  AlertPlugin,
  PluginFetchOptions,
  PluginFetchResult,
  PluginMetadata,
  Alert,
} from '../types';

const LOCATION = { latitude: 44.0755, longitude: -121.3301 }; // Bend, OR
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function metadata(id: string, dataLagMinutes?: number): PluginMetadata {
  return {
    id,
    name: `${id} feed`,
    version: '1.0.0',
    description: id,
    coverage: { type: 'global', description: 'everywhere' },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      ...(dataLagMinutes === undefined ? {} : { dataLagMinutes }),
      freshnessDescription: 'test',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['crime'],
  };
}

function alertAgedMs(id: string, ageMs: number): Alert {
  return {
    id,
    title: id,
    description: '',
    riskLevel: 'high',
    priority: 1,
    category: 'crime',
    temporalType: 'historical',
    location: { point: LOCATION },
    timestamps: { issued: new Date(Date.now() - ageMs).toISOString() },
    source: { pluginId: id, name: id, type: 'police' },
  } as Alert;
}

/** A source that publishes `dataLagMinutes` late and returns `alerts`. */
function plugin(id: string, dataLagMinutes: number | undefined, alerts: Alert[]): AlertPlugin {
  return {
    metadata: metadata(id, dataLagMinutes),
    coversLocation: (): boolean => true,
    async fetchAlerts(_options: PluginFetchOptions): Promise<PluginFetchResult> {
      return { alerts };
    },
  };
}

/** The window the guard console defaults to for a bare "what's happening near me". */
function triageWindow() {
  return {
    start: new Date(Date.now() - DAY_MS).toISOString(),
    end: new Date(Date.now() + DAY_MS).toISOString(),
  };
}

describe('per-source freshness — telling a quiet night from an unpublished one', () => {
  it('flags a source whose publication delay outruns the requested window', async () => {
    // Bend PD publishes ~2 days late. Asked for the last 24h it has nothing —
    // not because the town was quiet, but because nothing is published yet.
    const feed = new AlertFeed({
      plugins: [{ plugin: plugin('bend-police', 2 * 24 * 60, []), enabled: true }],
    });

    const res = await feed.query({ location: LOCATION, timeRange: triageWindow() });

    expect(res.alerts).toHaveLength(0);
    const source = res.meta.sources?.find((s) => s.pluginId === 'bend-police');
    expect(source).toBeDefined();
    expect(source!.lagExceedsWindow).toBe(true);
    expect(source!.dataLagMinutes).toBe(2880);
    expect(source!.alertCount).toBe(0);

    // asOf is the freshest instant it could know about — ~2 days ago.
    const asOfAgeMs = Date.now() - new Date(source!.asOf!).getTime();
    expect(asOfAgeMs).toBeGreaterThan(2 * DAY_MS - MINUTE_MS);

    // And it offers a window that would actually reach the data, rather than
    // applying one — stale data is not an answer to "what's happening now".
    expect(source!.suggestedTimeRange).toBeDefined();
    const suggestedStart = new Date(source!.suggestedTimeRange!.start).getTime();
    expect(suggestedStart).toBeLessThan(Date.now() - 2 * DAY_MS);

    await feed.dispose();
  });

  it('does not flag a prompt source that simply had nothing to report', async () => {
    // Same empty result, entirely different meaning: a 5-minute-lag feed asked
    // about the last 24h really is telling you it was quiet.
    const feed = new AlertFeed({
      plugins: [{ plugin: plugin('live-dispatch', 5, []), enabled: true }],
    });

    const res = await feed.query({ location: LOCATION, timeRange: triageWindow() });

    const source = res.meta.sources?.find((s) => s.pluginId === 'live-dispatch');
    expect(source?.lagExceedsWindow).toBe(false);
    expect(source?.suggestedTimeRange).toBeUndefined();
    await feed.dispose();
  });

  it('leaves results untouched — freshness is reported, never applied', async () => {
    // A source may declare a long delay and still emit something currently valid
    // (phoenix-crime-risk declares 30 days but publishes a live area score).
    // Flagging it must not drop or widen anything.
    const fresh = alertAgedMs('score', 60 * MINUTE_MS);
    const feed = new AlertFeed({
      plugins: [{ plugin: plugin('crime-risk', 30 * 24 * 60, [fresh]), enabled: true }],
    });

    const res = await feed.query({ location: LOCATION, timeRange: triageWindow() });

    expect(res.alerts.map((a) => a.id)).toEqual(['score']);
    const source = res.meta.sources?.find((s) => s.pluginId === 'crime-risk');
    expect(source?.lagExceedsWindow).toBe(true); // flagged…
    expect(source?.alertCount).toBe(1); // …but its alert still came through
    await feed.dispose();
  });

  it('reports a source that declares no delay without inventing one', async () => {
    const feed = new AlertFeed({
      plugins: [{ plugin: plugin('no-lag-declared', undefined, []), enabled: true }],
    });

    const res = await feed.query({ location: LOCATION, timeRange: triageWindow() });

    const source = res.meta.sources?.find((s) => s.pluginId === 'no-lag-declared');
    expect(source).toBeDefined();
    expect(source!.dataLagMinutes).toBeUndefined();
    expect(source!.asOf).toBeUndefined();
    expect(source!.lagExceedsWindow).toBe(false);
    await feed.dispose();
  });

  it('stops flagging once the window reaches past the delay', async () => {
    // The same 2-day-late source, asked over a week: the window now covers data
    // it has actually published, so there is nothing to caveat.
    const feed = new AlertFeed({
      plugins: [{ plugin: plugin('bend-police', 2 * 24 * 60, []), enabled: true }],
    });

    const res = await feed.query({
      location: LOCATION,
      timeRange: {
        start: new Date(Date.now() - 7 * DAY_MS).toISOString(),
        end: new Date(Date.now() + DAY_MS).toISOString(),
      },
    });

    const source = res.meta.sources?.find((s) => s.pluginId === 'bend-police');
    expect(source?.lagExceedsWindow).toBe(false);
    expect(source?.suggestedTimeRange).toBeUndefined();
    // The lag itself is still reported — it's true regardless of the window.
    expect(source?.dataLagMinutes).toBe(2880);
    await feed.dispose();
  });
});
