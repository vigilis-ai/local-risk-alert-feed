/**
 * Plugin-service handler — the **server** side of federation.
 *
 * One Lambda hosts many plugins, each on its own route (an endpoint is a route,
 * not a deployment):
 *
 *   GET  {base}/plugins/{id}/manifest
 *   POST {base}/plugins/{id}/alerts
 *   GET  {base}/plugins/{id}/health
 *
 * This is how our first-party plugins are published so we "operate like any
 * third party": bundle the plugins you want, deploy once, and re-segment later
 * by moving plugins between deployments — a config change, not a code change.
 *
 * Each request is authenticated with the same bearer + HMAC scheme the host
 * uses to call it; the signed path is derived from `(id, action)` so stage
 * prefixes don't break verification.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { AlertPlugin } from '../types';
import {
  PluginFetchOptionsSchema,
  canonicalPath,
  MANIFEST_ACTION,
  ALERTS_ACTION,
  HEALTH_ACTION,
  CONTRACT_VERSION,
  type PluginManifest,
  type PluginHealthResult,
} from '../contract';
import { verifyRequest, type CredentialResolver } from '../federation';

export interface PluginServiceOptions {
  /** The plugins this module serves. Each is exposed at `/plugins/{id}/…`. */
  plugins: AlertPlugin[];
  /** Resolves each plugin id's bearer token + signing secret for verification. */
  credentials: CredentialResolver;
  /** Whether a plugin advertises realtime push (reserved; default false). */
  supportsPush?: (pluginId: string) => boolean;
  /** Signature replay tolerance in ms (default: library default). */
  signatureToleranceMs?: number;
}

export type PluginServiceHandler = (
  event: APIGatewayProxyEvent,
  context: Context
) => Promise<APIGatewayProxyResult>;

/** Match `…/plugins/{id}/{action}` off the end of a request path. */
function matchRoute(path: string): { id: string; action: string } | null {
  const m = path.match(/\/plugins\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]), action: m[2] };
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build a health probe for a plugin from its own manifest, letting explicit
 * query parameters override any part of it.
 *
 * Deriving the defaults here rather than in the caller is the point of this
 * action: the plugin already declares where it covers, how far behind its
 * source runs, and whether it can see the past at all. A caller that had to
 * supply those would be keeping a second copy of facts the plugin owns — and
 * that copy goes stale silently the moment a plugin's coverage or lag changes.
 *
 * Two traps this encodes, both of which produce a *false* empty result rather
 * than an error, which is why they're worth defaulting carefully:
 *
 *  - **A window shorter than the source's publication lag returns nothing no
 *    matter how healthy the source is.** A feed running 120 days behind probed
 *    over 24 hours is indistinguishable from a dead one. So the default window
 *    spans twice the declared lag.
 *  - **A backward window is unsatisfiable for a forward-only source.** Event
 *    feeds (`supportsPast: false`) only know about the future; probing them
 *    backwards always returns zero.
 */
function buildProbe(
  metadata: AlertPlugin['metadata'],
  q: Record<string, string | undefined>
): { latitude: number; longitude: number; radiusMeters: number; start: Date; end: Date } | null {
  const latitude = num(q.lat) ?? metadata.coverage?.center?.latitude;
  const longitude = num(q.lng) ?? metadata.coverage?.center?.longitude;
  // A global/national source has no center to probe; the caller must say where.
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;

  const radiusMeters =
    num(q.radiusMeters) ??
    metadata.defaultRadiusMeters ??
    metadata.coverage?.radiusMeters ??
    15_000;

  const lagHours = (metadata.temporal?.dataLagMinutes ?? 0) / 60;
  const supportsPast = metadata.temporal?.supportsPast ?? true;
  const supportsFuture = metadata.temporal?.supportsFuture ?? false;

  const lookbackHours = num(q.lookbackHours) ?? (supportsPast ? Math.max(24, lagHours * 2) : 0);
  const lookaheadHours = num(q.lookaheadHours) ?? (supportsPast ? 0 : supportsFuture ? 720 : 0);

  const now = Date.now();
  return {
    latitude,
    longitude,
    radiusMeters,
    start: new Date(now - lookbackHours * 3_600_000),
    end: new Date(now + lookaheadHours * 3_600_000),
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Create a Lambda handler that serves many plugins behind one deployment.
 */
export function createPluginServiceHandler(options: PluginServiceOptions): PluginServiceHandler {
  const byId = new Map(options.plugins.map((p) => [p.metadata.id, p]));
  // Initialize plugins once at cold start (best-effort; matches registry behavior).
  const ready = Promise.all(
    options.plugins.map((p) => (p.initialize ? p.initialize() : Promise.resolve()))
  ).catch((err) => {
    console.error('Plugin service initialization error:', err);
  });

  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    await ready;

    const rawPath = event.path ?? '';
    const route = matchRoute(rawPath);
    if (!route) {
      return json(404, { error: 'Not Found', message: 'expected /plugins/{id}/{manifest|alerts|health}' });
    }

    const plugin = byId.get(route.id);
    if (!plugin) {
      return json(404, { error: 'Not Found', message: `no plugin "${route.id}"` });
    }

    // Authenticate against this plugin's credentials.
    const method = event.httpMethod;
    const body = event.body ?? '';
    let credentials;
    try {
      credentials = await options.credentials.resolve(route.id);
    } catch {
      return json(500, { error: 'Server misconfiguration', message: 'credentials unavailable' });
    }
    const verdict = verifyRequest({
      credentials,
      headers: event.headers as Record<string, string | undefined>,
      method,
      canonicalPath: canonicalPath(route.id, route.action),
      body,
      toleranceMs: options.signatureToleranceMs,
    });
    if (!verdict.ok) {
      return json(401, { error: 'Unauthorized', message: verdict.reason });
    }

    try {
      if (route.action === MANIFEST_ACTION && method === 'GET') {
        const manifest: PluginManifest = {
          contractVersion: CONTRACT_VERSION,
          supportsPush: options.supportsPush?.(route.id) ?? false,
          metadata: plugin.metadata,
        };
        return json(200, manifest);
      }

      if (route.action === HEALTH_ACTION && method === 'GET') {
        const q = (event.queryStringParameters ?? {}) as Record<string, string | undefined>;
        const probe = buildProbe(plugin.metadata, q);
        if (!probe) {
          return json(400, {
            error: 'Validation Error',
            message: `plugin "${route.id}" declares no coverage center; pass lat and lng`,
          });
        }
        // Default false: an empty result is only a failure for a source that is
        // *supposed* to always have something. Defaulting true would mark every
        // legitimately quiet feed — a flood warning service on a dry day —
        // unhealthy, and an alarm that cries wolf gets ignored.
        const expectedData = q.expectData === 'true';
        const startedAt = Date.now();
        const checkedAt = new Date().toISOString();
        const shape = {
          pluginId: route.id,
          expectedData,
          checkedAt,
          probe: {
            latitude: probe.latitude,
            longitude: probe.longitude,
            radiusMeters: probe.radiusMeters,
            start: probe.start.toISOString(),
            end: probe.end.toISOString(),
          },
        };

        try {
          const result = await plugin.fetchAlerts({
            location: { latitude: probe.latitude, longitude: probe.longitude },
            radiusMeters: probe.radiusMeters,
            timeRange: { start: probe.start.toISOString(), end: probe.end.toISOString() },
            limit: num(q.limit) ?? 25,
          });
          const recordCount = result.alerts.length;
          const health: PluginHealthResult = {
            ...shape,
            status: recordCount > 0 ? 'healthy' : expectedData ? 'unhealthy' : 'quiet',
            recordCount,
            latencyMs: Date.now() - startedAt,
          };
          return json(200, health);
        } catch (err) {
          // Deliberately 200: the probe ran and produced a verdict. Answering
          // 5xx would conflate "this plugin's upstream is down" with "the
          // plugin service is down", and the caller needs to tell those apart.
          const health: PluginHealthResult = {
            ...shape,
            status: 'unhealthy',
            latencyMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : 'unexpected error',
          };
          return json(200, health);
        }
      }

      if (route.action === ALERTS_ACTION && method === 'POST') {
        const parsed = PluginFetchOptionsSchema.safeParse(body ? JSON.parse(body) : {});
        if (!parsed.success) {
          return json(400, { error: 'Validation Error', issues: parsed.error.issues });
        }
        const result = await plugin.fetchAlerts(parsed.data);
        return json(200, result);
      }

      return json(405, { error: 'Method Not Allowed' });
    } catch (err) {
      console.error(`Plugin "${route.id}" error:`, err);
      return json(500, {
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : 'unexpected error',
      });
    }
  };
}
