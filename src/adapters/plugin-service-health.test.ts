import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import type { AlertPlugin, GeoPoint, PluginFetchOptions, PluginFetchResult } from '../types';
import { computeSignature } from '../federation/auth';
import type { CredentialResolver } from '../federation';
import { createPluginServiceHandler } from './plugin-service';

/**
 * Health probes for `GET /plugins/{id}/health`.
 *
 * The point of these is the three-state verdict. Two states cannot separate
 * "this source has nothing to say today" from "this source is broken", and for
 * a risk feed those need opposite responses — so `quiet` vs `unhealthy` is what
 * most of this file is about.
 */

const credentials: CredentialResolver = {
  async resolve(id: string) {
    return { token: `token-${id}`, signingSecret: `secret-${id}` };
  },
};

interface FakeOptions {
  id: string;
  alerts?: number;
  throws?: string;
  supportsPast?: boolean;
  supportsFuture?: boolean;
  dataLagMinutes?: number;
  center?: GeoPoint;
}

/** Records the options it was called with, so tests can assert the derived window. */
class FakePlugin implements AlertPlugin {
  readonly metadata: AlertPlugin['metadata'];
  lastCall?: PluginFetchOptions;

  constructor(private readonly opts: FakeOptions) {
    this.metadata = {
      id: opts.id,
      name: opts.id,
      version: '1.0.0',
      description: 'test',
      coverage: opts.center
        ? { type: 'regional' as const, center: opts.center, radiusMeters: 20_000, description: 'x' }
        : { type: 'global' as const, description: 'everywhere' },
      temporal: {
        supportsPast: opts.supportsPast ?? true,
        supportsFuture: opts.supportsFuture ?? false,
        dataLagMinutes: opts.dataLagMinutes ?? 5,
        freshnessDescription: 'test',
      },
      supportedTemporalTypes: ['real-time' as const],
      supportedCategories: ['weather' as const],
    };
  }

  coversLocation(_p: GeoPoint): boolean {
    return true;
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    this.lastCall = options;
    if (this.opts.throws) throw new Error(this.opts.throws);
    return {
      alerts: Array.from({ length: this.opts.alerts ?? 0 }, (_, i) => ({
        id: `a${i}`,
        title: 'x',
        description: 'x',
        riskLevel: 'low' as const,
        priority: 1,
        category: 'weather' as const,
        temporalType: 'real-time' as const,
        location: { point: options.location },
        timestamps: { issued: '2026-08-01T00:00:00.000Z' },
        source: { pluginId: this.opts.id, name: this.opts.id, type: 'weather' },
      })),
    };
  }
}

async function probe(plugin: FakePlugin, query: Record<string, string> = {}) {
  const handler = createPluginServiceHandler({ plugins: [plugin], credentials });
  const id = plugin.metadata.id;
  const timestampMs = Date.now();
  const canonical = `/plugins/${id}/health`;
  const sig = computeSignature({
    signingSecret: `secret-${id}`,
    timestampMs,
    method: 'GET',
    canonicalPath: canonical,
    body: '',
  });

  const res = await handler(
    {
      // A stage prefix on the raw path must not break verification — the signed
      // path is derived from (id, action), never from the HTTP path.
      path: `/dev${canonical}`,
      httpMethod: 'GET',
      headers: {
        authorization: `Bearer token-${id}`,
        'x-vigilis-signature': `t=${timestampMs},v1=${sig}`,
      },
      queryStringParameters: Object.keys(query).length ? query : null,
      body: null,
    } as unknown as APIGatewayProxyEvent,
    {} as Context,
  );

  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

describe('plugin-service /health', () => {
  const center = { latitude: 30.2672, longitude: -97.7431 };

  it('reports healthy when the probe returns records', async () => {
    const { statusCode, body } = await probe(new FakePlugin({ id: 'p1', alerts: 3, center }));
    expect(statusCode).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.recordCount).toBe(3);
    expect(body.pluginId).toBe('p1');
  });

  it('reports quiet — not unhealthy — when empty and no data was expected', async () => {
    // A flood feed on a dry day. Calling this a failure is how an alarm earns
    // its way into being ignored.
    const { body } = await probe(new FakePlugin({ id: 'p2', alerts: 0, center }));
    expect(body.status).toBe('quiet');
    expect(body.recordCount).toBe(0);
    expect(body.expectedData).toBe(false);
  });

  it('reports unhealthy when empty and data WAS expected', async () => {
    const { body } = await probe(new FakePlugin({ id: 'p3', alerts: 0, center }), {
      expectData: 'true',
    });
    expect(body.status).toBe('unhealthy');
    expect(body.expectedData).toBe(true);
  });

  it('answers 200 with a verdict when the upstream throws', async () => {
    // Deliberately not 5xx: "this plugin's upstream is down" and "the plugin
    // service is down" are different failures and the caller must separate them.
    const { statusCode, body } = await probe(
      new FakePlugin({ id: 'p4', throws: 'HTTP 429 from upstream', center }),
    );
    expect(statusCode).toBe(200);
    expect(body.status).toBe('unhealthy');
    expect(body.error).toContain('429');
    expect(body.recordCount).toBeUndefined();
  });

  it('spans twice the declared lag, so a lagging source is not read as dead', async () => {
    // 120 days behind: a 24h window would return nothing however healthy it is.
    const plugin = new FakePlugin({ id: 'p5', alerts: 1, center, dataLagMinutes: 120 * 24 * 60 });
    await probe(plugin);
    const { start, end } = plugin.lastCall!.timeRange;
    const spanHours = (Date.parse(end) - Date.parse(start)) / 3_600_000;
    expect(spanHours).toBeGreaterThanOrEqual(240 * 24);
  });

  it('probes forward for a source that cannot see the past', async () => {
    // Event feeds only know about the future; a backward window is unsatisfiable.
    const plugin = new FakePlugin({
      id: 'p6',
      alerts: 2,
      center,
      supportsPast: false,
      supportsFuture: true,
    });
    await probe(plugin);
    const { start, end } = plugin.lastCall!.timeRange;
    expect(Date.parse(end)).toBeGreaterThan(Date.now());
    expect(Date.parse(start)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('defaults the location from the plugin coverage, and lets a caller override', async () => {
    const plugin = new FakePlugin({ id: 'p7', alerts: 1, center });
    await probe(plugin);
    expect(plugin.lastCall!.location).toEqual(center);

    await probe(plugin, { lat: '51.5', lng: '-0.12', radiusMeters: '5000' });
    expect(plugin.lastCall!.location.latitude).toBeCloseTo(51.5);
    expect(plugin.lastCall!.radiusMeters).toBe(5000);
  });

  it('asks for a location when the plugin declares no coverage center', async () => {
    const { statusCode, body } = await probe(new FakePlugin({ id: 'p8', alerts: 1 }));
    expect(statusCode).toBe(400);
    expect(body.message).toContain('lat');
  });

  it('rejects an unsigned request', async () => {
    const plugin = new FakePlugin({ id: 'p9', alerts: 1, center });
    const handler = createPluginServiceHandler({ plugins: [plugin], credentials });
    const res = await handler(
      {
        path: '/plugins/p9/health',
        httpMethod: 'GET',
        headers: {},
        queryStringParameters: null,
        body: null,
      } as unknown as APIGatewayProxyEvent,
      {} as Context,
    );
    expect(res.statusCode).toBe(401);
  });
});
