import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import type { AlertPlugin, PluginFetchOptions, PluginFetchResult, GeoPoint } from '../types';
import { FederationClient } from './client';
import { RemotePlugin } from './remote-plugin';
import { StaticRegistrationStore, loadRemotePlugins, type CredentialResolver } from './store';
import { computeSignature, verifyRequest } from './auth';
import { createPluginServiceHandler } from '../adapters/plugin-service';

/** A trivial in-memory plugin used as the "remote" endpoint's implementation. */
class FakeWeatherPlugin implements AlertPlugin {
  readonly metadata = {
    id: 'fake-weather',
    name: 'Fake Weather',
    version: '1.0.0',
    description: 'test',
    coverage: { type: 'global' as const, description: 'everywhere' },
    temporal: {
      supportsPast: true,
      supportsFuture: true,
      dataLagMinutes: 5,
      freshnessDescription: 'near real-time',
    },
    supportedTemporalTypes: ['real-time' as const],
    supportedCategories: ['weather' as const],
  };
  coversLocation(_p: GeoPoint): boolean {
    return true;
  }
  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    return {
      alerts: [
        {
          id: 'a1',
          title: 'Heat advisory',
          description: 'It is hot',
          riskLevel: 'high',
          priority: 3,
          category: 'weather',
          temporalType: 'real-time',
          location: { point: options.location },
          timestamps: { issued: '2026-07-02T00:00:00.000Z' },
          source: { pluginId: 'fake-weather', name: 'Fake Weather', type: 'weather' },
        },
      ],
    };
  }
}

const creds: CredentialResolver = {
  async resolve(id) {
    return { token: `token-${id}`, signingSecret: `secret-${id}` };
  },
};

/** Turn the server handler into a `fetch`-compatible function for the client. */
function handlerAsFetch(handler: ReturnType<typeof createPluginServiceHandler>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(typeof url === 'string' ? url : url.toString());
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const event = {
      path: u.pathname,
      httpMethod: init?.method ?? 'GET',
      headers,
      body: (init?.body as string | undefined) ?? null,
    } as unknown as APIGatewayProxyEvent;
    const res = await handler(event, {} as Context);
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('auth', () => {
  it('accepts a correctly signed request and rejects tampering', () => {
    const credentials = { token: 'tok', signingSecret: 'sec' };
    const timestampMs = 1_000_000;
    const sig = computeSignature({
      signingSecret: 'sec',
      timestampMs,
      method: 'POST',
      canonicalPath: '/plugins/x/alerts',
      body: '{"a":1}',
    });
    const headers = {
      authorization: 'Bearer tok',
      'x-vigilis-signature': `t=${timestampMs},v1=${sig}`,
    };
    expect(
      verifyRequest({
        credentials,
        headers,
        method: 'POST',
        canonicalPath: '/plugins/x/alerts',
        body: '{"a":1}',
        nowMs: timestampMs,
      }).ok
    ).toBe(true);

    // Tampered body → mismatch.
    expect(
      verifyRequest({
        credentials,
        headers,
        method: 'POST',
        canonicalPath: '/plugins/x/alerts',
        body: '{"a":2}',
        nowMs: timestampMs,
      }).ok
    ).toBe(false);

    // Stale timestamp → replay rejection.
    expect(
      verifyRequest({
        credentials,
        headers,
        method: 'POST',
        canonicalPath: '/plugins/x/alerts',
        body: '{"a":1}',
        nowMs: timestampMs + 10 * 60 * 1000,
      }).ok
    ).toBe(false);
  });
});

describe('federation round-trip', () => {
  it('host RemotePlugin talks to the multi-plugin service handler', async () => {
    const handler = createPluginServiceHandler({
      plugins: [new FakeWeatherPlugin()],
      credentials: creds,
    });
    const client = new FederationClient({ fetchImpl: handlerAsFetch(handler) });

    const plugin = new RemotePlugin({
      id: 'fake-weather',
      endpoint: 'https://plugins.example.test',
      credentials: await creds.resolve('fake-weather'),
      client,
    });

    // Manifest (control plane) drives coverage.
    await plugin.initialize();
    expect(plugin.metadata.name).toBe('Fake Weather');
    expect(plugin.coversLocation({ latitude: 33.4, longitude: -112 })).toBe(true);

    // Alerts (data plane).
    const result = await plugin.fetchAlerts({
      location: { latitude: 33.4, longitude: -112 },
      radiusMeters: 5000,
      timeRange: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z' },
    });
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].title).toBe('Heat advisory');
  });

  it('loadRemotePlugins builds registrations from a store', async () => {
    const handler = createPluginServiceHandler({
      plugins: [new FakeWeatherPlugin()],
      credentials: creds,
    });
    const client = new FederationClient({ fetchImpl: handlerAsFetch(handler) });
    const store = new StaticRegistrationStore([
      { id: 'fake-weather', endpoint: 'https://plugins.example.test' },
    ]);

    const registrations = await loadRemotePlugins({ store, credentials: creds, client });
    expect(registrations).toHaveLength(1);
    expect(registrations[0].plugin.metadata.id).toBe('fake-weather');
  });

  it('rejects a request signed with the wrong secret', async () => {
    const handler = createPluginServiceHandler({
      plugins: [new FakeWeatherPlugin()],
      credentials: creds,
    });
    const client = new FederationClient({ fetchImpl: handlerAsFetch(handler) });
    const plugin = new RemotePlugin({
      id: 'fake-weather',
      endpoint: 'https://plugins.example.test',
      credentials: { token: 'token-fake-weather', signingSecret: 'WRONG' },
      client,
    });
    await expect(plugin.initialize()).rejects.toThrow();
  });
});
