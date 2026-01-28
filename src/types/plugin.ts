import type { GeoPoint } from './geo';
import type { Alert, AlertCategory, AlertTemporalType } from './alert';
import type { TimeRange } from './query';

/**
 * Coverage type for a plugin.
 * - regional: Covers a specific geographic area (center + radius)
 * - global: Covers all locations worldwide
 */
export type PluginCoverageType = 'regional' | 'global';

/**
 * Describes the temporal characteristics of a plugin's data.
 * Used to determine if a plugin is relevant for a given time range query.
 */
export interface PluginTemporalCharacteristics {
  /**
   * Whether the plugin provides data about past events.
   */
  supportsPast: boolean;

  /**
   * Whether the plugin provides data about future/scheduled events.
   */
  supportsFuture: boolean;

  /**
   * Typical data lag in minutes (for past-facing data).
   * How long after an event occurs before it appears in the data.
   * - 5 = near real-time
   * - 60 = hourly updates
   * - 1440 = 24 hour delay
   * - 2880 = 48 hour delay
   *
   * Undefined if supportsFuture only.
   */
  dataLagMinutes?: number;

  /**
   * How far into the future the plugin can see, in minutes.
   * - 10080 = 7 days
   * - 43200 = 30 days
   *
   * Undefined if supportsPast only.
   */
  futureLookaheadMinutes?: number;

  /**
   * Human-readable description of data freshness.
   * e.g., "Near real-time", "1-2 day delay", "Scheduled events up to 30 days"
   */
  freshnessDescription: string;
}

/**
 * Describes the geographic coverage of a plugin.
 */
export interface PluginCoverage {
  /** Type of coverage */
  type: PluginCoverageType;
  /** Center point for regional coverage */
  center?: GeoPoint;
  /** Radius in meters for regional coverage */
  radiusMeters?: number;
  /** Human-readable description of the coverage area */
  description: string;
}

/**
 * Metadata describing a plugin's capabilities and coverage.
 */
export interface PluginMetadata {
  /** Unique identifier for the plugin */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version string */
  version: string;
  /** Description of what the plugin provides */
  description: string;
  /** Geographic coverage information */
  coverage: PluginCoverage;
  /** Temporal characteristics describing data freshness and direction */
  temporal: PluginTemporalCharacteristics;
  /** Temporal types this plugin can provide */
  supportedTemporalTypes: AlertTemporalType[];
  /** Alert categories this plugin can provide */
  supportedCategories: AlertCategory[];
  /** Suggested refresh interval in milliseconds */
  refreshIntervalMs?: number;
}

/**
 * Options passed to a plugin when fetching alerts.
 */
export interface PluginFetchOptions {
  /** The location being queried */
  location: GeoPoint;
  /** Radius around the location in meters */
  radiusMeters: number;
  /** Time range for alerts */
  timeRange: TimeRange;
  /** Maximum number of alerts to return */
  limit?: number;
  /** Filter by specific categories */
  categories?: AlertCategory[];
  /** Filter by specific temporal types */
  temporalTypes?: AlertTemporalType[];
}

/**
 * Result returned by a plugin's fetchAlerts method.
 */
export interface PluginFetchResult {
  /** Alerts fetched by the plugin */
  alerts: Alert[];
  /** Whether the results were served from cache */
  fromCache?: boolean;
  /** Cache key used (if applicable) */
  cacheKey?: string;
  /** When the cache entry expires (if applicable) */
  cacheExpiresAt?: string;
  /** Any warnings generated during fetch */
  warnings?: string[];
}

/**
 * Interface that all alert plugins must implement.
 */
export interface AlertPlugin {
  /** Plugin metadata describing capabilities and coverage */
  readonly metadata: PluginMetadata;

  /**
   * Initialize the plugin with optional configuration.
   * Called once when the plugin is registered.
   */
  initialize?(config?: Record<string, unknown>): Promise<void>;

  /**
   * Check if this plugin covers the given geographic point.
   * @param point - The location to check
   * @returns true if the plugin can provide alerts for this location
   */
  coversLocation(point: GeoPoint): boolean;

  /**
   * Fetch alerts based on the provided options.
   * @param options - Query options including location, time range, etc.
   * @returns Promise resolving to the fetch result with alerts
   */
  fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult>;

  /**
   * Clean up resources when the plugin is unregistered.
   */
  dispose?(): Promise<void>;
}

/**
 * Information about a plugin's execution result.
 */
export interface PluginResultInfo {
  /** Plugin identifier */
  pluginId: string;
  /** Plugin name */
  pluginName: string;
  /** Whether the plugin executed successfully */
  success: boolean;
  /** Number of alerts returned */
  alertCount: number;
  /** Execution time in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Whether results came from cache */
  fromCache?: boolean;
  /** Any warnings generated */
  warnings?: string[];
  /** Whether the plugin was skipped due to temporal incompatibility */
  skipped?: boolean;
  /** Reason the plugin was skipped */
  skipReason?: string;
}
