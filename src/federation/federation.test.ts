import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import type { AlertPlugin, PluginFetchOptions, PluginFetchResult, GeoPoint } from '../types';
import { FederationClient } from './client';
import { RemotePlugin } from './remote-plugin';
import {
  StaticRegistrationStore,
  loadRemotePlugins,
  primaryCredential,
  type CredentialResolver,
} from './store';
import { computeSignature, verifyRequest } from './auth';
import { EgressPolicy, EgressBlockedError, isBlockedIp } from './egress';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { ResponseTooLargeError } from './client';
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

  it('accepts either credential during a rotation window', () => {
    const rotated = [
      { token: 'new-tok', signingSecret: 'new-sec' },
      { token: 'old-tok', signingSecret: 'old-sec' },
    ];
    const timestampMs = 2_000_000;
    // A caller still signing with the OLD (previous) credential.
    const oldSig = computeSignature({
      signingSecret: 'old-sec',
      timestampMs,
      method: 'POST',
      canonicalPath: '/plugins/x/alerts',
      body: '{}',
    });
    const res = verifyRequest({
      credentials: rotated,
      headers: {
        authorization: 'Bearer old-tok',
        'x-vigilis-signature': `t=${timestampMs},v1=${oldSig}`,
      },
      method: 'POST',
      canonicalPath: '/plugins/x/alerts',
      body: '{}',
      nowMs: timestampMs,
    });
    expect(res.ok).toBe(true);

    // Mixed old token + new secret must NOT pass (must match the same credential).
    const newSig = computeSignature({
      signingSecret: 'new-sec',
      timestampMs,
      method: 'POST',
      canonicalPath: '/plugins/x/alerts',
      body: '{}',
    });
    expect(
      verifyRequest({
        credentials: rotated,
        headers: {
          authorization: 'Bearer old-tok',
          'x-vigilis-signature': `t=${timestampMs},v1=${newSig}`,
        },
        method: 'POST',
        canonicalPath: '/plugins/x/alerts',
        body: '{}',
        nowMs: timestampMs,
      }).ok
    ).toBe(false);
  });
});

describe('response-size caps', () => {
  const okCreds = { token: 't', signingSecret: 's' };

  it('rejects on an oversized Content-Length before reading', async () => {
    const client = new FederationClient({
      maxResponseBytes: 1024,
      fetchImpl: (async () =>
        new Response('{}', {
          headers: { 'content-length': String(10 * 1024 * 1024) },
        })) as unknown as typeof fetch,
    });
    await expect(
      client.getManifest('https://plugins.example.test', 'x', okCreds)
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('rejects when the streamed body exceeds the cap', async () => {
    const big = 'x'.repeat(5000);
    const client = new FederationClient({
      maxResponseBytes: 1000,
      fetchImpl: (async () => new Response(big)) as unknown as typeof fetch,
    });
    await expect(
      client.getManifest('https://plugins.example.test', 'x', okCreds)
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe('circuit breaker', () => {
  it('opens after the threshold, fails fast, then recovers half-open', async () => {
    let clock = 0;
    let calls = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => clock });
    const fail = () => {
      calls++;
      return Promise.reject(new Error('boom'));
    };

    // Two failures trip it.
    await expect(breaker.execute(fail)).rejects.toThrow('boom');
    await expect(breaker.execute(fail)).rejects.toThrow('boom');
    expect(breaker.currentState).toBe('open');
    expect(calls).toBe(2);

    // While open + cooling down: fail fast, fn NOT called.
    await expect(breaker.execute(fail)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);

    // After cooldown: half-open trial runs; success closes it.
    clock += 1001;
    await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });
});

describe('egress policy (SSRF guard)', () => {
  it('classifies private / metadata / public addresses', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true); // cloud metadata
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('10.1.2.3')).toBe(true);
    expect(isBlockedIp('192.168.0.5')).toBe(true);
    expect(isBlockedIp('172.16.4.4')).toBe(true);
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fd00:ec2::254')).toBe(true);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('93.184.216.34')).toBe(false);
  });

  it('blocks http, private IPs and the metadata endpoint by default', async () => {
    const policy = new EgressPolicy();
    await expect(policy.assertAllowed('http://example.com/x')).rejects.toBeInstanceOf(
      EgressBlockedError
    );
    await expect(policy.assertAllowed('https://169.254.169.254/latest')).rejects.toBeInstanceOf(
      EgressBlockedError
    );
    await expect(policy.assertAllowed('https://10.0.0.1/x')).rejects.toBeInstanceOf(
      EgressBlockedError
    );
    await expect(policy.assertAllowed('https://plugins.example.com/x')).resolves.toBeUndefined();
  });

  it('enforces an allowlist', async () => {
    const policy = new EgressPolicy({ allowedHosts: ['.trusted.io'] });
    await expect(policy.assertAllowed('https://api.trusted.io/x')).resolves.toBeUndefined();
    await expect(policy.assertAllowed('https://evil.example/x')).rejects.toBeInstanceOf(
      EgressBlockedError
    );
  });

  it('range-checks resolved DNS addresses when enabled', async () => {
    const policy = new EgressPolicy({
      resolveDns: true,
      lookup: async () => ['169.254.169.254'], // hostname secretly resolves to metadata
    });
    await expect(policy.assertAllowed('https://sneaky.example/x')).rejects.toBeInstanceOf(
      EgressBlockedError
    );
  });

  it('the client rejects a blocked endpoint before fetching', async () => {
    let fetched = false;
    const client = new FederationClient({
      fetchImpl: (async () => {
        fetched = true;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    await expect(
      client.getManifest('https://169.254.169.254', 'x', { token: 't', signingSecret: 's' })
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetched).toBe(false);
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
      credentials: primaryCredential(await creds.resolve('fake-weather')),
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

  it('re-fetches the manifest after the TTL expires', async () => {
    const handler = createPluginServiceHandler({
      plugins: [new FakeWeatherPlugin()],
      credentials: creds,
    });
    // Count manifest fetches by wrapping the stitched fetch.
    let manifestCalls = 0;
    const baseFetch = handlerAsFetch(handler);
    const countingFetch = ((url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/manifest')) manifestCalls++;
      return baseFetch(url, init);
    }) as typeof fetch;

    const client = new FederationClient({ fetchImpl: countingFetch });
    let clock = 1_000_000;
    const plugin = new RemotePlugin({
      id: 'fake-weather',
      endpoint: 'https://plugins.example.test',
      credentials: primaryCredential(await creds.resolve('fake-weather')),
      client,
      manifestTtlMs: 60_000,
      now: () => clock,
    });

    await plugin.initialize();
    expect(manifestCalls).toBe(1);

    const opts: PluginFetchOptions = {
      location: { latitude: 33.4, longitude: -112 },
      radiusMeters: 5000,
      timeRange: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z' },
    };

    // Within TTL: no refetch.
    clock += 30_000;
    await plugin.fetchAlerts(opts);
    expect(manifestCalls).toBe(1);

    // Past TTL: refetch on next fetchAlerts.
    clock += 40_000;
    await plugin.fetchAlerts(opts);
    expect(manifestCalls).toBe(2);
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
