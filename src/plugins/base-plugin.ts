import type {
  AlertPlugin,
  PluginMetadata,
  PluginFetchOptions,
  PluginFetchResult,
  GeoPoint,
  Alert,
  RiskLevel,
  AlertPriority,
  CacheProvider,
} from '../types';
import { isPointInRadius } from '../geo';
import { FetchError } from '../errors';
import { withRetry, generateCacheKey, parseCSV } from '../utils';
import type { CSVParseOptions } from '../utils';
import { XMLParser } from 'fast-xml-parser';
import type { X2jOptions } from 'fast-xml-parser';

/**
 * Configuration for base plugin.
 */
export interface BasePluginConfig {
  /** Cache provider for storing fetched data */
  cache?: CacheProvider;
  /** Default cache TTL in milliseconds */
  cacheTtlMs?: number;
  /** Number of retry attempts for failed requests */
  maxRetries?: number;
  /** User-Agent header for HTTP requests */
  userAgent?: string;
}

/**
 * Abstract base class for alert plugins.
 *
 * Provides common functionality for:
 * - Location coverage checking
 * - HTTP fetching with retry
 * - Caching
 * - Alert creation helpers
 */
export abstract class BasePlugin implements AlertPlugin {
  abstract readonly metadata: PluginMetadata;

  protected config: BasePluginConfig;
  protected cache?: CacheProvider;

  /** Global fallback cache TTL when a plugin declares none. */
  protected static readonly DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(config?: BasePluginConfig) {
    // Note: `cacheTtlMs` is intentionally NOT defaulted here so per-source TTL
    // (metadata.refreshIntervalMs) can take effect; see getCacheTtlMs().
    this.config = {
      maxRetries: 3,
      userAgent: 'LocalRiskAlertFeed/1.0',
      ...config,
    };
    this.cache = config?.cache;
  }

  /**
   * Initialize the plugin. Override if needed.
   */
  async initialize(config?: Record<string, unknown>): Promise<void> {
    if (config?.cache) {
      this.cache = config.cache as CacheProvider;
    }
    if (config?.cacheTtlMs) {
      this.config.cacheTtlMs = config.cacheTtlMs as number;
    }
  }

  /**
   * Check if this plugin covers the given location.
   *
   * For global plugins, always returns true.
   * For regional plugins, checks if the point is within the coverage radius.
   */
  coversLocation(point: GeoPoint): boolean {
    const { coverage } = this.metadata;

    if (coverage.type === 'global') {
      return true;
    }

    if (coverage.center && coverage.radiusMeters) {
      return isPointInRadius(point, coverage.center, coverage.radiusMeters);
    }

    return false;
  }

  /**
   * Fetch alerts. Must be implemented by subclasses.
   */
  abstract fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult>;

  /**
   * Clean up resources. Override if needed.
   */
  async dispose(): Promise<void> {
    // Default: no cleanup needed
  }

  /**
   * Fetch JSON data from a URL with retry logic.
   */
  protected async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          ...init,
          headers: {
            'User-Agent': this.config.userAgent!,
            Accept: 'application/json',
            ...init?.headers,
          },
        });

        if (!response.ok) {
          throw FetchError.fromResponse(url, response);
        }

        return response.json() as Promise<T>;
      },
      {
        maxAttempts: this.config.maxRetries,
        isRetryable: (error) => {
          if (error instanceof FetchError) {
            return error.isRetryable();
          }
          return true;
        },
      }
    );
  }

  /**
   * Fetch CSV data from a URL with retry logic.
   *
   * @param url - The URL to fetch from
   * @param options - CSV parsing options
   * @param init - Optional fetch init options
   * @returns Parsed CSV data as array of objects
   */
  protected async fetchCsv<T extends Record<string, unknown> = Record<string, unknown>>(
    url: string,
    options?: CSVParseOptions,
    init?: RequestInit
  ): Promise<T[]> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          ...init,
          headers: {
            'User-Agent': this.config.userAgent!,
            Accept: 'text/csv, application/csv, */*',
            ...init?.headers,
          },
        });

        if (!response.ok) {
          throw FetchError.fromResponse(url, response);
        }

        const text = await response.text();
        return parseCSV<T>(text, options);
      },
      {
        maxAttempts: this.config.maxRetries,
        isRetryable: (error) => {
          if (error instanceof FetchError) {
            return error.isRetryable();
          }
          return true;
        },
      }
    );
  }

  /**
   * Fetch and parse XML data from a URL with retry logic.
   *
   * @param url - The URL to fetch from
   * @param parserOptions - Options forwarded to fast-xml-parser's XMLParser
   * @param init - Optional fetch init options
   * @returns Parsed XML as a plain object
   */
  protected async fetchXml<T = unknown>(
    url: string,
    parserOptions?: X2jOptions,
    init?: RequestInit
  ): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetch(url, {
          ...init,
          headers: {
            'User-Agent': this.config.userAgent!,
            Accept: 'application/xml, text/xml, */*',
            ...init?.headers,
          },
        });

        if (!response.ok) {
          throw FetchError.fromResponse(url, response);
        }

        const text = await response.text();
        const parser = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          trimValues: true,
          ...parserOptions,
        });
        return parser.parse(text) as T;
      },
      {
        maxAttempts: this.config.maxRetries,
        isRetryable: (error) => {
          if (error instanceof FetchError) {
            return error.isRetryable();
          }
          return true;
        },
      }
    );
  }

  /**
   * Get cached data or fetch fresh data.
   */
  protected async getCachedOrFetch<T>(
    cacheKey: string,
    fetcher: () => Promise<T>,
    ttlMs?: number
  ): Promise<{ data: T; fromCache: boolean }> {
    if (this.cache) {
      const cached = await this.cache.get<T>(cacheKey);
      if (cached !== null) {
        return { data: cached, fromCache: true };
      }
    }

    const data = await fetcher();

    if (this.cache) {
      await this.cache.set(cacheKey, data, this.getCacheTtlMs(ttlMs));
    }

    return { data, fromCache: false };
  }

  /**
   * Resolve the cache TTL for this plugin (per-source TTL).
   *
   * Precedence: explicit argument → plugin `cacheTtlMs` config → the plugin's
   * own `metadata.refreshIntervalMs` (its declared freshness) → global default.
   * This lets each source cache for as long as its data stays fresh — e.g. a
   * throttled events feed can use a long TTL while a real-time feed stays short.
   */
  protected getCacheTtlMs(explicitMs?: number): number {
    return (
      explicitMs ??
      this.config.cacheTtlMs ??
      this.metadata.refreshIntervalMs ??
      BasePlugin.DEFAULT_CACHE_TTL_MS
    );
  }

  /**
   * Generate a query-exact cache key for this plugin and query options.
   * Every result-affecting field (location, radius, time window, filters,
   * limit) is part of the key, so cached data is never reused for a materially
   * different query.
   */
  protected generateCacheKey(options: PluginFetchOptions): string {
    return generateCacheKey({
      pluginId: this.metadata.id,
      location: options.location,
      radiusMeters: options.radiusMeters,
      timeRange: options.timeRange,
      categories: options.categories,
      temporalTypes: options.temporalTypes,
      limit: options.limit,
    });
  }

  /**
   * Create an alert with common fields filled in.
   */
  protected createAlert(
    data: Omit<Alert, 'source'> & { externalId?: string }
  ): Alert {
    const { externalId, ...rest } = data;
    return {
      ...rest,
      source: {
        pluginId: this.metadata.id,
        name: this.metadata.name,
        externalId,
        type: this.getSourceType(),
      },
    };
  }

  /**
   * Get the source type based on plugin categories.
   */
  protected getSourceType(): Alert['source']['type'] {
    const categories = this.metadata.supportedCategories;

    if (categories.includes('crime')) return 'police';
    if (categories.includes('fire') || categories.includes('medical')) return 'fire';
    if (categories.includes('weather')) return 'weather';
    if (categories.includes('traffic')) return 'traffic';
    if (categories.includes('event')) return 'events';
    return 'other';
  }

  /**
   * Resolve the host's fetch budget for this query.
   *
   * The host tells every plugin how many records it can actually use
   * (`maxResults`), how it will rank them (`rank`), and the risk floor it will
   * apply (`minRiskLevel`). A plugin that ignores this still works — it just
   * burns time and bandwidth pulling records the aggregator throws away, which
   * is what made a busy police feed take 15s over the wire to contribute ~10
   * alerts.
   *
   * Use it to bound the upstream query:
   *   const { maxRecords, rank } = this.resolveFetchBudget(options, 500);
   *   params.set('resultRecordCount', String(maxRecords));
   *   params.set('orderByFields', rank === 'severity' ? SEVERITY_ORDER : RECENCY_ORDER);
   *
   * @param options - the fetch options the host passed in
   * @param ceiling - this plugin's own hard cap (its safety limit)
   */
  protected resolveFetchBudget(
    options: PluginFetchOptions,
    ceiling: number
  ): { maxRecords: number; rank: 'severity' | 'recency'; minRiskLevel?: RiskLevel } {
    const requested = options.maxResults;
    const maxRecords =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.min(ceiling, Math.ceil(requested))
        : ceiling;

    return {
      maxRecords,
      // Default to severity: if the host didn't say, assume the caller wants the
      // worst things — never silently drop a shooting to keep a parking call.
      rank: options.rank ?? 'severity',
      minRiskLevel: options.minRiskLevel,
    };
  }

  /**
   * Map a numeric severity to a risk level.
   *
   * @param value - Numeric value (0-100 scale)
   * @returns Corresponding risk level
   */
  protected mapToRiskLevel(value: number): RiskLevel {
    if (value >= 80) return 'extreme';
    if (value >= 60) return 'severe';
    if (value >= 40) return 'high';
    if (value >= 20) return 'moderate';
    return 'low';
  }

  /**
   * Map a risk level to a priority.
   */
  protected riskLevelToPriority(level: RiskLevel): AlertPriority {
    const map: Record<RiskLevel, AlertPriority> = {
      extreme: 1,
      severe: 2,
      high: 3,
      moderate: 4,
      low: 5,
    };
    return map[level];
  }

  /**
   * Create an empty result (no alerts).
   */
  protected emptyResult(): PluginFetchResult {
    return { alerts: [] };
  }
}
