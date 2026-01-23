import type { AlertPlugin } from './plugin';

/**
 * Cache provider interface for storing and retrieving cached data.
 */
export interface CacheProvider {
  /**
   * Get a value from the cache.
   * @param key - Cache key
   * @returns The cached value or null if not found
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set a value in the cache.
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttlMs - Time to live in milliseconds
   */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;

  /**
   * Delete a value from the cache.
   * @param key - Cache key
   */
  delete(key: string): Promise<void>;

  /**
   * Check if a key exists in the cache.
   * @param key - Cache key
   * @returns true if the key exists
   */
  has(key: string): Promise<boolean>;
}

/**
 * Plugin registration with optional configuration.
 */
export interface PluginRegistration {
  /** The plugin instance */
  plugin: AlertPlugin;
  /** Optional plugin-specific configuration */
  config?: Record<string, unknown>;
  /** Whether this plugin is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Configuration options for the AlertFeed.
 */
export interface AlertFeedConfig {
  /** Plugins to register */
  plugins?: PluginRegistration[];
  /** Cache provider for caching responses */
  cache?: CacheProvider;
  /** Default cache TTL in milliseconds (default: 5 minutes) */
  defaultCacheTtlMs?: number;
  /** Timeout for plugin fetch operations in milliseconds (default: 30 seconds) */
  pluginTimeoutMs?: number;
  /** Whether to continue if a plugin fails (default: true) */
  continueOnPluginError?: boolean;
  /** Maximum concurrent plugin fetches (default: 5) */
  maxConcurrentFetches?: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: Required<
  Pick<
    AlertFeedConfig,
    'defaultCacheTtlMs' | 'pluginTimeoutMs' | 'continueOnPluginError' | 'maxConcurrentFetches'
  >
> = {
  defaultCacheTtlMs: 5 * 60 * 1000, // 5 minutes
  pluginTimeoutMs: 30 * 1000, // 30 seconds
  continueOnPluginError: true,
  maxConcurrentFetches: 5,
};
