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
  /**
   * Hard cap on a plugin response body, in bytes. Reading aborts and throws
   * {@link ResponseTooLargeError} past this. Default 16 MB — ~10× the worst
   * realistic current response (a 1000-alert crime feed ≈ 1.5 MB), so no
   * current plugin is affected.
   */
  maxResponseBytes?: number;
  /**
   * Soft threshold, in bytes: responses larger than this log a warning (but are
   * still returned) so real production sizes are visible and the hard cap can
   * be recalibrated. Default 4 MB.
   */
  warnResponseBytes?: number;
}

/** Thrown when a plugin response body exceeds {@link FederationClientOptions.maxResponseBytes}. */
export class ResponseTooLargeError extends Error {
  constructor(url: string, bytes: number, limit: number) {
    super(`Response from ${url} exceeded ${limit} bytes (got at least ${bytes})`);
    this.name = 'ResponseTooLargeError';
    Object.setPrototypeOf(this, ResponseTooLargeError.prototype);
  }
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
  private readonly maxResponseBytes: number;
  private readonly warnResponseBytes: number;

  constructor(options: FederationClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'VigilisAlertFeed-Host/1.0';
    this.now = options.now ?? (() => Date.now());
    this.egress = options.egress ?? new EgressPolicy();
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    this.warnResponseBytes = options.warnResponseBytes ?? 4 * 1024 * 1024;
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
      const text = await this.readLimited(res, url);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read a response body while enforcing the size caps. Rejects early on an
   * oversized `Content-Length`, streams with a running byte count so a lying or
   * absent header can't blow past the hard cap, and warns past the soft one.
   */
  private async readLimited(res: Response, url: string): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared > this.maxResponseBytes) {
      throw new ResponseTooLargeError(url, declared, this.maxResponseBytes);
    }

    const reader = res.body?.getReader?.();
    if (!reader) {
      // No stream available (e.g. a mocked Response) — buffer then check.
      const text = await res.text();
      const bytes = Buffer.byteLength(text);
      if (bytes > this.maxResponseBytes) {
        throw new ResponseTooLargeError(url, bytes, this.maxResponseBytes);
      }
      this.warnIfLarge(url, bytes);
      return text;
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > this.maxResponseBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(url, received, this.maxResponseBytes);
      }
      chunks.push(value);
    }
    this.warnIfLarge(url, received);
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }

  private warnIfLarge(url: string, bytes: number): void {
    if (bytes > this.warnResponseBytes) {
      console.warn(
        `Federation: response from ${url} is ${bytes} bytes (> ${this.warnResponseBytes} warn threshold)`
      );
    }
  }
}
