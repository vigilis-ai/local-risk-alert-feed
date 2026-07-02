// Main AlertFeed class
export { AlertFeed } from './core';

// Core components
export { PluginRegistry, PluginResolver, AlertAggregator } from './core';
export { resolveTimeRange, normalizeTimeRange, parseRelativeRange } from './core';
export type { PluginResolveOptions, ResolvedPlugin, AggregateOptions, AlertSortOrder } from './core';

// Types
export type {
  // Geo types
  GeoPoint,
  GeoBoundingBox,
  GeoCircle,
  AlertLocation,
  // Alert types
  Alert,
  RiskLevel,
  AlertPriority,
  AlertCategory,
  AlertTemporalType,
  AlertSourceType,
  AlertTimestamps,
  AlertSource,
  // Plugin types
  AlertPlugin,
  PluginMetadata,
  PluginCoverage,
  PluginCoverageType,
  PluginFetchOptions,
  PluginFetchResult,
  PluginResultInfo,
  // Query types
  AlertQuery,
  AlertQueryResponse,
  AlertQueryMeta,
  TimeRange,
  TimeRangePreset,
  TimeRangeInput,
  // Config types
  AlertFeedConfig,
  PluginRegistration,
  CacheProvider,
} from './types';

// Type constants
export {
  RISK_LEVEL_VALUES,
  RISK_LEVELS,
  ALERT_CATEGORIES,
  ALERT_TEMPORAL_TYPES,
  TIME_RANGE_PRESETS,
  DEFAULT_QUERY_RADIUS_METERS,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  DEFAULT_CONFIG,
} from './types';

// Schemas
export {
  AlertSchema,
  AlertQuerySchema,
  AlertQueryRequestSchema,
  GeoPointSchema,
  TimeRangeSchema,
  transformRequestToQuery,
} from './schemas';

// Errors
export {
  PluginError,
  PluginInitializationError,
  PluginFetchError,
  PluginTimeoutError,
  DuplicatePluginError,
  PluginNotFoundError,
  ValidationError,
  FetchError,
} from './errors';
export type { ValidationIssue } from './errors';

// Geo utilities
export {
  haversineDistance,
  calculateDistance,
  calculateBearing,
  destinationPoint,
  isPointInRadius,
  isPointInCircle,
  isPointInBoundingBox,
  doCirclesOverlap,
  getBoundingBoxForRadius,
} from './geo';

// Cache providers
export {
  InMemoryCacheProvider,
  VercelKVCacheProvider,
  DynamoDBCacheProvider,
  generateCacheKey,
} from './utils';

// Utility functions
export { withRetry, withTimeout, sleep, TimeoutError } from './utils';
export type { RetryOptions } from './utils';

// Base plugin for building custom plugins
export { BasePlugin } from './plugins';
export type { BasePluginConfig } from './plugins';

// Canonical default plugin list (includes every production plugin, TRANSCOM disabled-safe)
export { createDefaultPlugins } from './plugins';
export type { DefaultPluginsOptions } from './plugins';

// Built-in plugins
export { NWSWeatherPlugin } from './plugins/weather';
export type { NWSWeatherPluginConfig } from './plugins/weather';

export { PhoenixFirePlugin, NIFCWildfirePlugin } from './plugins/fire-emt';
export type { PhoenixFirePluginConfig, NIFCWildfirePluginConfig } from './plugins/fire-emt';

export { PhoenixEventsPlugin, PhoenixConventionCenterPlugin } from './plugins/events';
export type { PhoenixEventsPluginConfig, PhoenixConventionCenterPluginConfig } from './plugins/events';

export { ArizonaTrafficPlugin } from './plugins/traffic';
export type { ArizonaTrafficPluginConfig } from './plugins/traffic';

export { AirNowPlugin } from './plugins/air-quality';
export type { AirNowPluginConfig } from './plugins/air-quality';

// CSV utilities (for custom plugins that need CSV parsing)
export { parseCSV, toCSV } from './utils';
export type { CSVParseOptions } from './utils';

// Federation — host-side clients for plugins that live behind HTTP endpoints
export {
  RemotePlugin,
  FederationClient,
  joinUrl,
  StaticRegistrationStore,
  EnvCredentialResolver,
  loadRemotePlugins,
  buildAuthHeaders,
  verifyRequest,
  computeSignature,
  parseSignatureHeader,
  normalizeHeaders,
  AUTH_HEADER,
  SIGNATURE_HEADER,
  DEFAULT_SIGNATURE_TOLERANCE_MS,
} from './federation';
export type {
  RemotePluginOptions,
  FederationClientOptions,
  RemotePluginRecord,
  RegistrationStore,
  CredentialResolver,
  LoadRemotePluginsOptions,
  PluginCredentials,
  VerifyResult,
} from './federation';

// Federation wire contract (schemas + version) — the public, versioned surface
export {
  CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  canonicalPath,
  PluginManifestSchema,
  PluginMetadataSchema,
  PluginFetchOptionsSchema,
  PluginFetchResultSchema,
} from './contract';
export type { PluginManifest, PluginFetchOptionsWire, PluginFetchResultWire } from './contract';
