/**
 * Plugin-service handler — the **server** side of federation.
 *
 * One Lambda hosts many plugins, each on its own route (an endpoint is a route,
 * not a deployment):
 *
 *   GET  {base}/plugins/{id}/manifest
 *   POST {base}/plugins/{id}/alerts
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
  CONTRACT_VERSION,
  type PluginManifest,
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
      return json(404, { error: 'Not Found', message: 'expected /plugins/{id}/{manifest|alerts}' });
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
