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
  /**
   * Overall deadline for this query across all plugins, in ms. Overrides the
   * feed-level `overallTimeoutMs`. Returns whatever finished by the deadline;
   * slow plugins are reported as incomplete rather than blocking the response.
   */
  overallTimeoutMs?: number;
}

/**
 * What one source contributed, and whether its publication delay means the
 * requested window could never have reached its data.
 *
 * This exists to separate two answers that look identical today: "nothing
 * happened near you" and "this source publishes days behind, so it has nothing
 * to say about the last 24 hours *yet*". Both arrive as zero alerts. Only the
 * first is a quiet night; the second is a question worth re-asking over a wider
 * window, and a caller that can't tell them apart will report a blind spot as an
 * all-clear.
 *
 * Reported for every source consulted, including ones skipped before they were
 * called. Nothing here changes which alerts are returned — it is context for
 * presenting them honestly.
 */
export interface SourceFreshness {
  /** Plugin id, e.g. `bend-police`. */
  pluginId: string;
  /** Human-readable plugin name, e.g. "Bend Police Department". */
  pluginName: string;
  /** How many alerts this source contributed (0 if skipped or empty). */
  alertCount: number;
  /** The source's declared publication delay in minutes, when it declares one. */
  dataLagMinutes?: number;
  /**
   * The most recent instant this source can know about (`now - dataLagMinutes`),
   * ISO 8601. Anything it returns is at best this old. Present only when the
   * source declares a delay.
   */
  asOf?: string;
  /**
   * True when the requested window starts *after* `asOf` — the whole window sits
   * inside this source's blind spot, so an empty result says nothing about
   * whether anything happened. This is the flag that turns "no alerts" into
   * "nothing published yet, ask again over a longer window".
   */
  lagExceedsWindow: boolean;
  /**
   * A window that WOULD reach this source's data: the requested span, shifted
   * back far enough to clear the delay. Present only when `lagExceedsWindow` is
   * true — offer it to the user rather than applying it silently, since data
   * from days ago is not an answer to "what is happening now".
   */
  suggestedTimeRange?: TimeRange;
  /** True when the source was skipped before being called. */
  skipped?: boolean;
  /** Why it was skipped, when it was. */
  skipReason?: string;
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
  /**
   * True when an overall deadline fired before every plugin finished, so the
   * result is a partial view. The plugins that didn't finish are listed in
   * `incompletePlugins`. Absent/false means every plugin completed.
   */
  partial?: boolean;
  /** Plugin ids that did not finish before the overall deadline. */
  incompletePlugins?: string[];
  /**
   * Per-source freshness for every source consulted. Lets a caller tell a quiet
   * night from a source that simply hasn't published yet, and offer a wider
   * window when one would help. See {@link SourceFreshness}.
   */
  sources?: SourceFreshness[];
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
