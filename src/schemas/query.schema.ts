import { z } from 'zod';
import {
  GeoPointSchema,
  RiskLevelSchema,
  AlertCategorySchema,
  AlertTemporalTypeSchema,
} from './alert.schema';
import { DEFAULT_QUERY_LIMIT, DEFAULT_QUERY_RADIUS_METERS, MAX_QUERY_LIMIT } from '../types';

/**
 * Schema for time range presets.
 */
export const TimeRangePresetSchema = z.enum([
  'past-24h',
  'past-7d',
  'past-30d',
  'next-4h',
  'next-12h',
  'next-24h',
  'next-7d',
]);

/**
 * Schema for explicit time range.
 */
export const TimeRangeSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
});

/**
 * Schema for time range input (preset or explicit).
 */
export const TimeRangeInputSchema = z.union([TimeRangePresetSchema, TimeRangeSchema]);

/**
 * Schema for alert query parameters.
 */
export const AlertQuerySchema = z.object({
  location: GeoPointSchema,
  radiusMeters: z.number().positive().max(100000).default(DEFAULT_QUERY_RADIUS_METERS),
  timeRange: TimeRangeInputSchema.optional(),
  limit: z.number().int().positive().max(MAX_QUERY_LIMIT).default(DEFAULT_QUERY_LIMIT),
  minRiskLevel: RiskLevelSchema.optional(),
  categories: z.array(AlertCategorySchema).optional(),
  temporalTypes: z.array(AlertTemporalTypeSchema).optional(),
  includePluginResults: z.boolean().default(false),
});

/**
 * Type inferred from the AlertQuerySchema.
 */
export type AlertQuerySchemaType = z.infer<typeof AlertQuerySchema>;

/**
 * Schema for validating incoming API request body.
 */
export const AlertQueryRequestSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().positive().max(100000).optional(),
  timeRange: TimeRangeInputSchema.optional(),
  limit: z.number().int().positive().max(MAX_QUERY_LIMIT).optional(),
  minRiskLevel: RiskLevelSchema.optional(),
  categories: z.array(AlertCategorySchema).optional(),
  temporalTypes: z.array(AlertTemporalTypeSchema).optional(),
  includePluginResults: z.boolean().optional(),
});

/**
 * Transform a request body into an AlertQuery.
 */
export function transformRequestToQuery(
  data: z.infer<typeof AlertQueryRequestSchema>
): z.infer<typeof AlertQuerySchema> {
  return {
    location: {
      latitude: data.latitude,
      longitude: data.longitude,
    },
    radiusMeters: data.radiusMeters ?? DEFAULT_QUERY_RADIUS_METERS,
    timeRange: data.timeRange,
    limit: data.limit ?? DEFAULT_QUERY_LIMIT,
    minRiskLevel: data.minRiskLevel,
    categories: data.categories,
    temporalTypes: data.temporalTypes,
    includePluginResults: data.includePluginResults ?? false,
  };
}
