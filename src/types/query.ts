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
/**
 * What the caller is trying to do. Drives how results are ranked and selected —
 * the same alerts, presented for a different question.
 *
 * - `triage` (default) — "what matters most near me, right now". Results are
 *   scored by severity, liveness and recency, then selected with a **fair share
 *   per category**, so one busy source can't monopolise the answer. Without
 *   this, a week of severe police calls fills every slot and an active fire
 *   next door never surfaces.
 * - `focused` — "show me X" (the caller named `categories` and/or `sources`).
 *   Severity is not the point: within the requested scope, return the fullest,
 *   most recent set. No cross-category balancing — the caller already chose.
 */
export type QueryIntent = 'triage' | 'focused';

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
  /**
   * Restrict to specific plugin ids (e.g. only fire/EMS response sources).
   * Plugins outside the list are not queried at all.
   */
  sources?: string[];
  /**
   * How to rank and select. Defaults to `focused` when `categories` or `sources`
   * is set (the caller has already narrowed the question), otherwise `triage`.
   * Set explicitly to override.
   */
  intent?: QueryIntent;
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
