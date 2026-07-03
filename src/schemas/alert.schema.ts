import { z } from 'zod';

/**
 * Optional string that also tolerates upstream `null` (common in third-party
 * feeds that emit `null` rather than omitting a field), normalizing it to
 * `undefined` so the validated output still matches the `?: string` interfaces.
 */
const optionalString = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

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
  address: optionalString,
  city: optionalString,
  state: optionalString,
  zipCode: optionalString,
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
// Must stay in sync with the `AlertSourceType` union in ../types/alert.ts.
export const AlertSourceTypeSchema = z.enum([
  'police',
  'fire',
  'weather',
  'events',
  'traffic',
  'other',
]);

/**
 * Optional ISO-8601 datetime that tolerates timezone offsets (e.g. NWS emits
 * "2026-07-03T14:00:00-04:00", not just UTC "…Z") and upstream nulls, which are
 * common for open-ended alerts. `null` is normalized to `undefined` so the
 * validated output still matches the `AlertTimestamps` interface (`?: string`).
 */
const optionalOffsetDateTime = z
  .string()
  .datetime({ offset: true })
  .nullish()
  .transform((v) => v ?? undefined);

/**
 * Schema for alert timestamps.
 */
export const AlertTimestampsSchema = z.object({
  issued: z.string().datetime({ offset: true }),
  eventStart: optionalOffsetDateTime,
  eventEnd: optionalOffsetDateTime,
  expires: optionalOffsetDateTime,
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
