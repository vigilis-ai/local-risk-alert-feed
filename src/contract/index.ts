/**
 * Federation wire contract.
 *
 * This module is the **public, versioned contract** a plugin endpoint speaks —
 * the thing third parties (and our own first-party plugin services) build
 * against, independent of our internal TypeScript. The host calls two routes on
 * a plugin's `endpoint`:
 *
 * - `GET  {endpoint}/manifest` → {@link PluginManifestSchema} (control plane)
 * - `POST {endpoint}/alerts`   → body {@link PluginFetchOptionsSchema},
 *                                response {@link PluginFetchResultSchema}
 *
 * URLs are intentionally **unversioned**; the contract version travels in the
 * manifest (and optionally the {@link CONTRACT_VERSION_HEADER}), so we can hold
 * compatibility or relocate the version later without churning endpoint paths.
 */
import { z } from 'zod';
import {
  GeoPointSchema,
  AlertSchema,
  AlertCategorySchema,
  AlertTemporalTypeSchema,
  TimeRangeSchema,
} from '../schemas';

/**
 * Current contract version. Bump only on a breaking change to the wire shapes.
 */
export const CONTRACT_VERSION = 1 as const;

/** Optional header echoing the contract version a request/response speaks. */
export const CONTRACT_VERSION_HEADER = 'x-contract-version';

/** Canonical route action names under a plugin's `{endpoint}/plugins/{id}`. */
export const MANIFEST_ACTION = 'manifest' as const;
export const ALERTS_ACTION = 'alerts' as const;

/**
 * Build the canonical, deployment-independent request path for a plugin action.
 *
 * Both the client (when signing) and the server (when verifying) derive the
 * signed path from `(id, action)` — never from the raw HTTP path — so stage
 * prefixes / custom base paths don't break signature verification.
 */
export function canonicalPath(pluginId: string, action: string): string {
  return `/plugins/${pluginId}/${action}`;
}

/** Geographic coverage of a plugin (mirror of {@link PluginCoverage}). */
export const PluginCoverageSchema = z.object({
  type: z.enum(['regional', 'global']),
  center: GeoPointSchema.optional(),
  radiusMeters: z.number().positive().optional(),
  description: z.string(),
});

/** Temporal characteristics (mirror of {@link PluginTemporalCharacteristics}). */
export const PluginTemporalCharacteristicsSchema = z.object({
  supportsPast: z.boolean(),
  supportsFuture: z.boolean(),
  dataLagMinutes: z.number().optional(),
  futureLookaheadMinutes: z.number().optional(),
  freshnessDescription: z.string(),
});

/** Plugin metadata (mirror of {@link PluginMetadata}). */
export const PluginMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string(),
  description: z.string(),
  coverage: PluginCoverageSchema,
  temporal: PluginTemporalCharacteristicsSchema,
  supportedTemporalTypes: z.array(AlertTemporalTypeSchema),
  supportedCategories: z.array(AlertCategorySchema),
  refreshIntervalMs: z.number().optional(),
  defaultRadiusMeters: z.number().optional(),
});

/**
 * Response body of `GET {endpoint}/manifest`.
 *
 * The metadata is what powers the host's resolver (geo / category / temporal
 * filtering) from cache, so the data plane is only hit when a plugin is
 * actually applicable.
 */
export const PluginManifestSchema = z.object({
  contractVersion: z.number().int().positive(),
  /** Reserved for the future push/callback direction; see design §4. */
  supportsPush: z.boolean().optional(),
  metadata: PluginMetadataSchema,
});

/**
 * Request body of `POST {endpoint}/alerts`.
 *
 * The host resolves `timeRange` to an explicit start/end before calling the
 * plugin, so endpoints always receive a concrete {@link TimeRangeSchema}.
 */
export const PluginFetchOptionsSchema = z.object({
  location: GeoPointSchema,
  radiusMeters: z.number().positive(),
  timeRange: TimeRangeSchema,
  limit: z.number().int().positive().optional(),
  categories: z.array(AlertCategorySchema).optional(),
  temporalTypes: z.array(AlertTemporalTypeSchema).optional(),
});

/** Response body of `POST {endpoint}/alerts` (mirror of {@link PluginFetchResult}). */
export const PluginFetchResultSchema = z.object({
  alerts: z.array(AlertSchema),
  fromCache: z.boolean().optional(),
  cacheKey: z.string().optional(),
  cacheExpiresAt: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginFetchOptionsWire = z.infer<typeof PluginFetchOptionsSchema>;
export type PluginFetchResultWire = z.infer<typeof PluginFetchResultSchema>;
