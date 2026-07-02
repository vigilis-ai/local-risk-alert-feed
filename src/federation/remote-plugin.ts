/**
 * Host-side representation of a plugin that lives behind an HTTP endpoint.
 *
 * `RemotePlugin` implements the same {@link AlertPlugin} interface as any local
 * plugin, so the existing registry / resolver / aggregator pipeline treats it
 * identically — a remote plugin is indistinguishable from a local one to
 * everything downstream, and the two can coexist during migration.
 *
 * - `initialize()` fetches + validates the plugin's `/manifest` (control plane)
 *   and caches the metadata, which powers the resolver without touching the
 *   data plane.
 * - `fetchAlerts()` calls `/alerts` (data plane) only when the resolver has
 *   already decided this plugin is applicable.
 */
import type { AlertPlugin, PluginMetadata, PluginFetchOptions, PluginFetchResult, GeoPoint } from '../types';
import { isPointInRadius } from '../geo';
import { PluginFetchError } from '../errors';
import { FederationClient } from './client';
import type { PluginCredentials } from './auth';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker';

export interface RemotePluginOptions {
  /** Stable plugin id — matches the registration row and the manifest. */
  id: string;
  /** Base endpoint URL (routes are `{endpoint}/plugins/{id}/…`). */
  endpoint: string;
  /** Bearer token + signing secret for this plugin. */
  credentials: PluginCredentials;
  /** Shared HTTP client (connection pooling lives here). */
  client: FederationClient;
  /**
   * How long a fetched manifest stays fresh, in ms. When set, the manifest is
   * lazily re-fetched on the next `fetchAlerts` after it expires (best-effort;
   * a failed refresh keeps the last-known-good metadata). Omit / 0 = load once.
   */
  manifestTtlMs?: number;
  /**
   * Per-plugin circuit breaker for the data-plane call. Pass options to enable
   * a fresh breaker, or a shared instance. Omit to disable (no breaker).
   */
  circuitBreaker?: CircuitBreakerOptions | CircuitBreaker;
  /** Injectable clock (testing). */
  now?: () => number;
}

export class RemotePlugin implements AlertPlugin {
  private readonly id: string;
  private readonly endpoint: string;
  private readonly credentials: PluginCredentials;
  private readonly client: FederationClient;
  private readonly manifestTtlMs?: number;
  private readonly now: () => number;
  private readonly breaker?: CircuitBreaker;

  private loaded = false;
  private loadedAt = 0;
  private _metadata: PluginMetadata;

  constructor(options: RemotePluginOptions) {
    this.id = options.id;
    this.endpoint = options.endpoint;
    this.credentials = options.credentials;
    this.client = options.client;
    this.manifestTtlMs = options.manifestTtlMs;
    this.now = options.now ?? (() => Date.now());
    if (options.circuitBreaker instanceof CircuitBreaker) {
      this.breaker = options.circuitBreaker;
    } else if (options.circuitBreaker) {
      this.breaker = new CircuitBreaker({ name: this.id, ...options.circuitBreaker });
    }

    // Placeholder metadata carries the real id (the registry reads `metadata.id`
    // before `initialize()` runs). Regional + no center/radius makes
    // `coversLocation()` return false, so an unloaded plugin never matches.
    this._metadata = {
      id: this.id,
      name: this.id,
      version: '0.0.0',
      description: 'Remote plugin (manifest not yet loaded)',
      coverage: { type: 'regional', description: 'unloaded' },
      temporal: {
        supportsPast: false,
        supportsFuture: false,
        freshnessDescription: 'unloaded',
      },
      supportedTemporalTypes: [],
      supportedCategories: [],
    };
  }

  get metadata(): PluginMetadata {
    return this._metadata;
  }

  /** Fetch + validate the manifest and cache its metadata. */
  async initialize(): Promise<void> {
    const manifest = await this.client.getManifest(this.endpoint, this.id, this.credentials);
    if (manifest.metadata.id !== this.id) {
      throw new PluginFetchError(
        this.id,
        `manifest id "${manifest.metadata.id}" does not match registration id "${this.id}"`
      );
    }
    this._metadata = manifest.metadata;
    this.loaded = true;
    this.loadedAt = this.now();
  }

  /**
   * Re-fetch the manifest if the TTL has expired. Best-effort: a failed refresh
   * logs and keeps the last-known-good metadata so a transient manifest hiccup
   * never fails a query.
   */
  private async ensureManifestFresh(): Promise<void> {
    if (!this.manifestTtlMs || !this.loaded) return;
    if (this.now() - this.loadedAt < this.manifestTtlMs) return;
    try {
      await this.initialize();
    } catch (err) {
      console.warn(
        `RemotePlugin "${this.id}" manifest refresh failed; using cached metadata:`,
        err
      );
    }
  }

  coversLocation(point: GeoPoint): boolean {
    const { coverage } = this._metadata;
    if (coverage.type === 'global') return true;
    if (coverage.center && coverage.radiusMeters) {
      return isPointInRadius(point, coverage.center, coverage.radiusMeters);
    }
    return false;
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    if (!this.loaded) {
      throw new PluginFetchError(this.id, 'manifest not loaded; call initialize() first');
    }
    await this.ensureManifestFresh();
    const doFetch = () =>
      this.client.postAlerts(this.endpoint, this.id, this.credentials, {
        location: options.location,
        radiusMeters: options.radiusMeters,
        timeRange: options.timeRange,
        limit: options.limit,
        categories: options.categories,
        temporalTypes: options.temporalTypes,
      });
    const result = this.breaker ? await this.breaker.execute(doFetch) : await doFetch();
    // Wire shape is validated by the client against the published Alert schema.
    return result as PluginFetchResult;
  }
}
