// Geo types
export type { GeoPoint, GeoBoundingBox, GeoCircle, AlertLocation } from './geo';

// Alert types
export type {
  RiskLevel,
  AlertPriority,
  AlertCategory,
  AlertTemporalType,
  AlertSourceType,
  AlertTimestamps,
  AlertSource,
  Alert,
} from './alert';
export {
  RISK_LEVEL_VALUES,
  RISK_LEVELS,
  ALERT_CATEGORIES,
  ALERT_TEMPORAL_TYPES,
} from './alert';

// Plugin types
export type {
  PluginCoverageType,
  PluginCoverage,
  PluginMetadata,
  PluginFetchOptions,
  PluginFetchResult,
  AlertPlugin,
  PluginResultInfo,
} from './plugin';

// Query types
export type {
  TimeRangePreset,
  TimeRange,
  TimeRangeInput,
  AlertQuery,
  AlertQueryMeta,
  AlertQueryResponse,
} from './query';
export {
  DEFAULT_QUERY_RADIUS_METERS,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  TIME_RANGE_PRESETS,
} from './query';

// Config types
export type { CacheProvider, PluginRegistration, AlertFeedConfig } from './config';
export { DEFAULT_CONFIG } from './config';
