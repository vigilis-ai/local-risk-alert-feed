import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import type { AlertPlugin, PluginFetchOptions, PluginFetchResult, GeoPoint } from '../types';
import { FederationClient } from '../federation';
import type { CredentialResolver } from '../federation';
import { createPluginServiceHandler } from '../adapters/plugin-service';
import { runConformanceSuite } from './conformance';

class GoodPlugin implements AlertPlugin {
  readonly metadata = {
    id: 'good-weather',
    name: 'Good Weather',
    version: '1.0.0',
    description: 'conformant test plugin',
    coverage: { type: 'global' as const, description: 'everywhere' },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 5,
      freshnessDescription: 'near real-time',
    },
    supportedTemporalTypes: ['real-time' as const],
    supportedCategories: ['weather' as const],
  };
  coversLocation(_p: GeoPoint): boolean {
    return true;
  }
  async fetchAlerts(o: PluginFetchOptions): Promise<PluginFetchResult> {
    return {
      alerts: [
        {
          id: 'a1',
          title: 'Heat advisory',
          description: 'hot',
          riskLevel: 'high',
          priority: 3,
          category: 'weather',
          temporalType: 'real-time',
          location: { point: o.location },
          timestamps: { issued: '2026-07-02T00:00:00.000Z' },
          source: { pluginId: 'good-weather', name: 'Good Weather', type: 'weather' },
        },
      ],
    };
  }
}

/** Emits an alert whose category is not in supportedCategories → must fail. */
class BadPlugin extends GoodPlugin {
  readonly metadata = { ...new GoodPlugin().metadata, id: 'bad-weather' };
  async fetchAlerts(o: PluginFetchOptions): Promise<PluginFetchResult> {
    const r = await super.fetchAlerts(o);
    return { alerts: [{ ...r.alerts[0], category: 'crime' }] };
  }
}

const creds: CredentialResolver = {
  async resolve(id) {
    return { token: `token-${id}`, signingSecret: `secret-${id}` };
  },
};

function handlerAsFetch(handler: ReturnType<typeof createPluginServiceHandler>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(typeof url === 'string' ? url : url.toString());
    const event = {
      path: u.pathname,
      httpMethod: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: (init?.body as string | undefined) ?? null,
    } as unknown as APIGatewayProxyEvent;
    const res = await handler(event, {} as Context);
    return new Response(res.body, { status: res.statusCode, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('conformance suite', () => {
  it('passes a conformant plugin (SDK-object mode)', async () => {
    const report = await runConformanceSuite({ plugin: new GoodPlugin() });
    expect(report.passed).toBe(true);
  });

  it('fails a plugin that emits out-of-contract categories', async () => {
    const report = await runConformanceSuite({ plugin: new BadPlugin() });
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name === 'fetchAlerts.categoriesSubset')?.passed).toBe(false);
  });

  it('passes a conformant endpoint and confirms auth enforcement (endpoint mode)', async () => {
    const handler = createPluginServiceHandler({ plugins: [new GoodPlugin()], credentials: creds });
    const fetchImpl = handlerAsFetch(handler);
    const report = await runConformanceSuite({
      endpoint: 'https://plugins.example.test',
      pluginId: 'good-weather',
      credentials: await creds.resolve('good-weather').then((c) => (Array.isArray(c) ? c[0] : c)),
      client: new FederationClient({ fetchImpl }),
      fetchImpl,
    });
    expect(report.passed).toBe(true);
    for (const name of ['auth.rejectsMissingBearer', 'auth.rejectsBadSignature', 'auth.rejectsStaleTimestamp']) {
      expect(report.checks.find((c) => c.name === name)?.passed).toBe(true);
    }
  });
});
