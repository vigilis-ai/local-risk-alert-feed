import type { CacheProvider } from '../types';

/**
 * Entry stored in the in-memory cache.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}

/**
 * In-memory cache provider implementation.
 * Suitable for development, testing, or single-instance deployments.
 */
export class InMemoryCacheProvider implements CacheProvider {
  private cache = new Map<string, CacheEntry<unknown>>();
  private cleanupIntervalId?: ReturnType<typeof setInterval>;

  constructor(cleanupIntervalMs = 60_000) {
    // Periodically clean up expired entries
    this.cleanupIntervalId = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      return null;
    }

    // Check if expired
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    this.cache.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  /**
   * Clear all entries from the cache.
   */
  async clear(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Get the number of entries in the cache.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Dispose of the cache provider and stop cleanup interval.
   */
  dispose(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
    this.cache.clear();
  }

  /**
   * Remove expired entries from the cache.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * Vercel KV cache provider implementation.
 * Requires @vercel/kv package to be installed.
 */
export class VercelKVCacheProvider implements CacheProvider {
  private kv: VercelKVClient;
  private prefix: string;

  constructor(kv: VercelKVClient, prefix = 'alert-feed:') {
    this.kv = kv;
    this.prefix = prefix;
  }

  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.kv.get<T>(this.getKey(key));
    return result ?? null;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const fullKey = this.getKey(key);
    if (ttlMs) {
      // Vercel KV expects TTL in seconds
      await this.kv.set(fullKey, value, { ex: Math.ceil(ttlMs / 1000) });
    } else {
      await this.kv.set(fullKey, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.kv.del(this.getKey(key));
  }

  async has(key: string): Promise<boolean> {
    const exists = await this.kv.exists(this.getKey(key));
    return exists === 1;
  }
}

/**
 * DynamoDB cache provider implementation.
 * Requires @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb packages.
 */
export class DynamoDBCacheProvider implements CacheProvider {
  private client: DynamoDBDocumentClient;
  private tableName: string;
  private keyAttribute: string;
  private valueAttribute: string;
  private ttlAttribute: string;

  constructor(
    client: DynamoDBDocumentClient,
    options: {
      tableName: string;
      keyAttribute?: string;
      valueAttribute?: string;
      ttlAttribute?: string;
    }
  ) {
    this.client = client;
    this.tableName = options.tableName;
    this.keyAttribute = options.keyAttribute ?? 'pk';
    this.valueAttribute = options.valueAttribute ?? 'value';
    this.ttlAttribute = options.ttlAttribute ?? 'ttl';
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.client.get({
      TableName: this.tableName,
      Key: { [this.keyAttribute]: key },
    });

    if (!result.Item) {
      return null;
    }

    // Check if TTL has expired (DynamoDB doesn't immediately delete expired items)
    const ttl = result.Item[this.ttlAttribute] as number | undefined;
    if (ttl && Date.now() / 1000 > ttl) {
      return null;
    }

    return result.Item[this.valueAttribute] as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const item: Record<string, unknown> = {
      [this.keyAttribute]: key,
      [this.valueAttribute]: value,
    };

    if (ttlMs) {
      // DynamoDB TTL expects Unix timestamp in seconds
      item[this.ttlAttribute] = Math.floor((Date.now() + ttlMs) / 1000);
    }

    await this.client.put({
      TableName: this.tableName,
      Item: item,
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.delete({
      TableName: this.tableName,
      Key: { [this.keyAttribute]: key },
    });
  }

  async has(key: string): Promise<boolean> {
    const result = await this.get(key);
    return result !== null;
  }
}

/**
 * Interface for Vercel KV client (matches @vercel/kv API).
 */
interface VercelKVClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ex?: number }): Promise<void>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<number>;
}

/**
 * Interface for DynamoDB Document Client (matches @aws-sdk/lib-dynamodb API).
 */
interface DynamoDBDocumentClient {
  get(params: {
    TableName: string;
    Key: Record<string, unknown>;
  }): Promise<{ Item?: Record<string, unknown> }>;
  put(params: { TableName: string; Item: Record<string, unknown> }): Promise<void>;
  delete(params: { TableName: string; Key: Record<string, unknown> }): Promise<void>;
}

/**
 * Parameters that identify a unique alert-feed query for caching.
 *
 * Every field that changes the result set is part of the key, so a cached
 * entry is only ever reused for an identical query. In particular the **radius**
 * and the **exact time window** are included — a west-Phoenix / 5km lookup can
 * never be served from an east-Phoenix or 10km entry, and a "past 6h" window
 * won't collide with a "past 24h" window on the same day.
 */
export interface CacheKeyParams {
  /** Plugin identifier. */
  pluginId: string;
  /** Query center. */
  location: { latitude: number; longitude: number };
  /** Resolved (explicit) time range. */
  timeRange: { start: string; end: string };
  /** Query radius in meters (distinct radii get distinct keys). */
  radiusMeters?: number;
  /** Category filter (order-independent). */
  categories?: string[];
  /** Temporal-type filter (order-independent). */
  temporalTypes?: string[];
  /** Result limit. */
  limit?: number;
  /**
   * Coordinate decimals to retain in the key (default 5 ≈ 1.1m — effectively
   * exact). Lower it deliberately (e.g. snap to a site) to share cache across
   * nearby queries; the framework never coarsens location on its own.
   */
  locationPrecision?: number;
}

/**
 * Generate a query-exact cache key. Reused only for an identical query
 * (plugin, location, radius, time window, filters, limit) so cached data is
 * never returned for a materially different request.
 */
export function generateCacheKey(params: CacheKeyParams): string {
  const precision = params.locationPrecision ?? 5;
  const lat = params.location.latitude.toFixed(precision);
  const lon = params.location.longitude.toFixed(precision);

  const parts = [
    `plugin=${params.pluginId}`,
    `loc=${lat},${lon}`,
    `r=${params.radiusMeters !== undefined ? Math.round(params.radiusMeters) : 'default'}`,
    // Full ISO window — no day-level truncation, so distinct windows never collide.
    `t=${params.timeRange.start}_${params.timeRange.end}`,
  ];
  if (params.categories?.length) {
    parts.push(`cat=${[...params.categories].sort().join(',')}`);
  }
  if (params.temporalTypes?.length) {
    parts.push(`tt=${[...params.temporalTypes].sort().join(',')}`);
  }
  if (params.limit !== undefined) {
    parts.push(`lim=${params.limit}`);
  }

  return `alert-feed:${parts.join(':')}`;
}
