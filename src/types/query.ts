import type { GeoPoint } from './geo';
import type { Alert, AlertCategory, AlertTemporalType, RiskLevel } from './alert';
import type { PluginResultInfo } from './plugin';

/**
 * Preset time range identifiers.
 */
export type TimeRangePreset =
  | 'past-24h'
  | 'past-7d'
  | 'past-30d'
  | 'next-4h'
  | 'next-12h'
  | 'next-24h'
  | 'next-7d';

/**
 * Explicit time range with start and end dates.
 */
export interface TimeRange {
  /** Start of the time range (ISO 8601 string) */
  start: string;
  /** End of the time range (ISO 8601 string) */
  end: string;
}

/**
 * Input type for time range that accepts either a preset or explicit range.
 */
export type TimeRangeInput = TimeRange | TimeRangePreset;

/**
 * Default radius in meters when not specified in a query.
 */
export const DEFAULT_QUERY_RADIUS_METERS = 10000; // 10km

/**
 * Default limit for number of alerts returned.
 */
export const DEFAULT_QUERY_LIMIT = 100;

/**
 * Maximum allowed limit for alerts.
 */
export const MAX_QUERY_LIMIT = 1000;

/**
 * Query parameters for fetching alerts.
 */
export interface AlertQuery {
  /** Center point for the query */
  location: GeoPoint;
  /** Radius around the location in meters */
  radiusMeters?: number;
  /** Time range for alerts (preset or explicit) */
  timeRange?: TimeRangeInput;
  /** Maximum number of alerts to return */
  limit?: number;
  /** Minimum risk level to include */
  minRiskLevel?: RiskLevel;
  /** Filter by specific categories */
  categories?: AlertCategory[];
  /** Filter by specific temporal types */
  temporalTypes?: AlertTemporalType[];
  /** Include detailed plugin execution information */
  includePluginResults?: boolean;
}

/**
 * Metadata about the query response.
 */
export interface AlertQueryMeta {
  /** Total number of alerts (before any client-side truncation) */
  totalCount: number;
  /** When the query was executed (ISO 8601 string) */
  queriedAt: string;
  /** Resolved time range used for the query */
  timeRange: TimeRange;
  /** Location that was queried */
  location: GeoPoint;
  /** Radius used for the query (undefined when each plugin used its own default) */
  radiusMeters?: number;
  /** Whether results were truncated due to limit */
  truncated: boolean;
}

/**
 * Response from an alert query.
 */
export interface AlertQueryResponse {
  /** Array of alerts matching the query */
  alerts: Alert[];
  /** Metadata about the query */
  meta: AlertQueryMeta;
  /** Detailed plugin execution results (if includePluginResults was true) */
  pluginResults?: PluginResultInfo[];
}

/**
 * All available time range presets.
 */
export const TIME_RANGE_PRESETS: TimeRangePreset[] = [
  'past-24h',
  'past-7d',
  'past-30d',
  'next-4h',
  'next-12h',
  'next-24h',
  'next-7d',
];
