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
 * Generate a cache key for alert feed queries.
 *
 * @param pluginId - Plugin identifier
 * @param location - Location coordinates
 * @param timeRange - Time range for the query
 * @returns A unique cache key string
 */
export function generateCacheKey(
  pluginId: string,
  location: { latitude: number; longitude: number },
  timeRange: { start: string; end: string }
): string {
  // Round coordinates to 3 decimal places (~100m precision) for cache hit efficiency
  const lat = location.latitude.toFixed(3);
  const lon = location.longitude.toFixed(3);
  const locationHash = `${lat},${lon}`;

  // Use date only for time range (hourly granularity would cause too many cache misses)
  const startDate = timeRange.start.slice(0, 10);
  const endDate = timeRange.end.slice(0, 10);
  const timeHash = `${startDate}_${endDate}`;

  return `alert-feed:${pluginId}:${locationHash}:${timeHash}`;
}
