/**
 * Host-side HTTP client for calling plugin endpoints.
 *
 * Handles URL construction, per-request signing (bearer + HMAC), timeouts, and
 * response schema validation. It deliberately uses the global `fetch` (undici
 * on Node 18+), whose default dispatcher already pools/keeps-alive connections
 * across warm Lambda invocations — the single most important perf lever for
 * federation. To tune the pool (or in tests), inject a configured `fetchImpl`.
 */
import {
  PluginManifestSchema,
  PluginFetchResultSchema,
  PluginFetchOptionsSchema,
  canonicalPath,
  MANIFEST_ACTION,
  ALERTS_ACTION,
  type PluginManifest,
  type PluginFetchResultWire,
} from '../contract';
import { FetchError } from '../errors';
import { buildAuthHeaders, type PluginCredentials } from './auth';
import { EgressPolicy } from './egress';

export interface FederationClientOptions {
  /** Per-request timeout in ms (default: 10s). */
  timeoutMs?: number;
  /** Injectable fetch (default: global fetch). Use to configure the connection pool or to test. */
  fetchImpl?: typeof fetch;
  /** User-Agent header sent with requests. */
  userAgent?: string;
  /** Injectable clock for signing timestamps (testing). */
  now?: () => number;
  /**
   * SSRF egress guard applied to every request URL. Defaults to a safe policy
   * (HTTPS-only, private/loopback/link-local/metadata IPs blocked). Pass your
   * own to add an allowlist or relax for local testing.
   */
  egress?: EgressPolicy;
}

/** Join a base endpoint with a canonical path, collapsing duplicate slashes. */
export function joinUrl(endpoint: string, path: string): string {
  return endpoint.replace(/\/+$/, '') + path;
}

export class FederationClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly egress: EgressPolicy;

  constructor(options: FederationClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'VigilisAlertFeed-Host/1.0';
    this.now = options.now ?? (() => Date.now());
    this.egress = options.egress ?? new EgressPolicy();
  }

  /** `GET {endpoint}/plugins/{id}/manifest` — control plane. */
  async getManifest(
    endpoint: string,
    pluginId: string,
    credentials: PluginCredentials
  ): Promise<PluginManifest> {
    const raw = await this.call(endpoint, pluginId, MANIFEST_ACTION, 'GET', credentials);
    return PluginManifestSchema.parse(raw);
  }

  /** `POST {endpoint}/plugins/{id}/alerts` — data plane. */
  async postAlerts(
    endpoint: string,
    pluginId: string,
    credentials: PluginCredentials,
    options: unknown
  ): Promise<PluginFetchResultWire> {
    const body = JSON.stringify(PluginFetchOptionsSchema.parse(options));
    const raw = await this.call(endpoint, pluginId, ALERTS_ACTION, 'POST', credentials, body);
    return PluginFetchResultSchema.parse(raw);
  }

  private async call(
    endpoint: string,
    pluginId: string,
    action: string,
    method: 'GET' | 'POST',
    credentials: PluginCredentials,
    body = ''
  ): Promise<unknown> {
    const path = canonicalPath(pluginId, action);
    const url = joinUrl(endpoint, path);

    // SSRF guard: validate the destination before doing anything else.
    await this.egress.assertAllowed(url);

    const timestampMs = this.now();

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
      ...buildAuthHeaders({ credentials, timestampMs, method, canonicalPath: path, body }),
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw FetchError.fromResponse(url, res);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
