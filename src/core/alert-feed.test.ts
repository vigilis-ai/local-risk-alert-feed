import { describe, it, expect } from 'vitest';
import { AlertFeed } from './alert-feed';
import type {
  AlertPlugin,
  PluginFetchOptions,
  PluginFetchResult,
  PluginMetadata,
  Alert,
} from '../types';

const LOCATION = { latitude: 47.6, longitude: -122.33 };

function metadata(id: string): PluginMetadata {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: id,
    coverage: { type: 'global', description: 'everywhere' },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 5,
      freshnessDescription: 'near real-time',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['crime', 'fire'],
  };
}

function sampleAlert(id: string): Alert {
  return {
    id,
    title: id,
    description: '',
    riskLevel: 'high',
    priority: 1,
    category: 'fire',
    temporalType: 'real-time',
    location: { point: LOCATION },
    // An hour ago, so it sits comfortably inside a past-24h window.
    timestamps: { issued: new Date(Date.now() - 3_600_000).toISOString() },
    source: { pluginId: id, name: id, type: 'fire' },
  } as Alert;
}

/** A plugin that answers after `delayMs`. */
function plugin(id: string, delayMs: number): AlertPlugin {
  return {
    metadata: metadata(id),
    coversLocation(): boolean {
      return true;
    },
    async fetchAlerts(_options: PluginFetchOptions): Promise<PluginFetchResult> {
      await new Promise((r) => setTimeout(r, delayMs));
      return { alerts: [sampleAlert(id)] };
    },
  };
}

describe('overall query deadline — a slow plugin never blocks the caller', () => {
  it('returns the fast plugins at the deadline and marks the slow one incomplete', async () => {
    const feed = new AlertFeed({
      pluginTimeoutMs: 30_000, // deliberately high: prove the OVERALL deadline is what bounds us
      overallTimeoutMs: 150,
      maxConcurrentFetches: 10,
      plugins: [
        { plugin: plugin('fast-a', 10), enabled: true },
        { plugin: plugin('fast-b', 20), enabled: true },
        { plugin: plugin('stuck', 5_000), enabled: true }, // would hang the whole call under the old scheme
      ],
    });

    const started = process.hrtime.bigint();
    const res = await feed.query({
      location: LOCATION,
      timeRange: 'past-24h',
      includePluginResults: true,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Bounded: nowhere near the 5s straggler.
    expect(elapsedMs).toBeLessThan(1_000);
    // Fast plugins made it in.
    const ids = res.alerts.map((a) => a.id).sort();
    expect(ids).toEqual(['fast-a', 'fast-b']);
    // The straggler is reported, not silently dropped.
    expect(res.meta.partial).toBe(true);
    expect(res.meta.incompletePlugins).toContain('stuck');
    await feed.dispose();
  });

  it('waits for everyone when no overall deadline is set (legacy behaviour)', async () => {
    const feed = new AlertFeed({
      pluginTimeoutMs: 30_000,
      maxConcurrentFetches: 10,
      plugins: [
        { plugin: plugin('a', 10), enabled: true },
        { plugin: plugin('b', 60), enabled: true },
      ],
    });
    const res = await feed.query({ location: LOCATION, timeRange: 'past-24h' });
    expect(res.alerts.map((a) => a.id).sort()).toEqual(['a', 'b']);
    expect(res.meta.partial).toBeUndefined();
    await feed.dispose();
  });
});
