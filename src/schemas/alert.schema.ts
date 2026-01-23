import { z } from 'zod';

/**
 * Schema for geographic point coordinates.
 */
export const GeoPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * Schema for alert location.
 */
export const AlertLocationSchema = z.object({
  point: GeoPointSchema,
  radiusMeters: z.number().positive().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
});

/**
 * Schema for risk levels.
 */
export const RiskLevelSchema = z.enum(['low', 'moderate', 'high', 'severe', 'extreme']);

/**
 * Schema for alert priority (1-5, where 1 is highest).
 */
export const AlertPrioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

/**
 * Schema for alert categories.
 */
export const AlertCategorySchema = z.enum([
  'crime',
  'fire',
  'medical',
  'weather',
  'traffic',
  'event',
  'civil-unrest',
  'other',
]);

/**
 * Schema for temporal types.
 */
export const AlertTemporalTypeSchema = z.enum(['historical', 'scheduled', 'real-time']);

/**
 * Schema for alert source types.
 */
export const AlertSourceTypeSchema = z.enum(['police', 'fire', 'weather', 'events', 'other']);

/**
 * Schema for alert timestamps.
 */
export const AlertTimestampsSchema = z.object({
  issued: z.string().datetime(),
  eventStart: z.string().datetime().optional(),
  eventEnd: z.string().datetime().optional(),
  expires: z.string().datetime().optional(),
});

/**
 * Schema for alert source.
 */
export const AlertSourceSchema = z.object({
  pluginId: z.string().min(1),
  name: z.string().min(1),
  externalId: z.string().optional(),
  type: AlertSourceTypeSchema,
});

/**
 * Schema for a complete alert.
 */
export const AlertSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  riskLevel: RiskLevelSchema,
  priority: AlertPrioritySchema,
  category: AlertCategorySchema,
  temporalType: AlertTemporalTypeSchema,
  location: AlertLocationSchema,
  timestamps: AlertTimestampsSchema,
  source: AlertSourceSchema,
  url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Type inferred from the AlertSchema.
 */
export type AlertSchemaType = z.infer<typeof AlertSchema>;
