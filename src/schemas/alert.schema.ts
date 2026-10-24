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
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Type inferred from the AlertSchema.
 */
export type AlertSchemaType = z.infer<typeof AlertSchema>;

/**
 * Degrade an OPTIONAL field instead of failing the alert that carries it.
 *
 * Anything that does not satisfy `inner` becomes `undefined`. Only ever applied
 * to fields the product can render without — never to id, title, category,
 * location.point or timestamps.issued, where a missing value means there is no
 * alert to show.
 */
function lenientOptional<T extends z.ZodTypeAny>(inner: T) {
  // `.optional()` keeps the key optional: zod 4 otherwise reads a transform
  // that can return undefined as a required key and rejects the alert.
  return z
    .unknown()
    .transform((value) => {
      if (value === undefined || value === null) return undefined;
      const parsed = inner.safeParse(value);
      return parsed.success ? (parsed.data as z.infer<T>) : undefined;
    })
    .optional();
}

/**
 * The runtime counterpart of {@link AlertSchema}: same required fields, but a
 * malformed OPTIONAL value is dropped rather than rejecting the alert.
 *
 * Why this exists. `url` is declared `z.string().url()`, and zod fails the whole
 * array it sits in — so a single provider sending `url: "county bulletin board"`
 * (or a relative path, or "") did not merely lose its link, it discarded EVERY
 * alert in that response. Measured before the fix: a batch of four with one
 * malformed url parsed to zero kept. `federation/client.ts` calls `.parse()`,
 * so that surfaced as a thrown plugin error and the feed simply went dark, with
 * nothing said to the user.
 *
 * The same hazard applied to every strict optional here — the offset datetimes,
 * radiusMeters, the address strings — so all of them degrade, not just url.
 *
 * {@link AlertSchema} stays strict on purpose: the conformance suite asserts
 * against it at error level, and a plugin emitting a bad url SHOULD fail
 * conformance and be fixed. Tolerance belongs at runtime, where the alternative
 * is showing a guard nothing.
 */
export const AlertSchemaLenient = AlertSchema.extend({
  location: AlertLocationSchema.extend({
    radiusMeters: lenientOptional(z.number().positive()),
    address: lenientOptional(z.string()),
    city: lenientOptional(z.string()),
    state: lenientOptional(z.string()),
    zipCode: lenientOptional(z.string()),
  }),
  timestamps: AlertTimestampsSchema.extend({
    eventStart: lenientOptional(z.string().datetime({ offset: true })),
    eventEnd: lenientOptional(z.string().datetime({ offset: true })),
    expires: lenientOptional(z.string().datetime({ offset: true })),
  }),
  source: AlertSourceSchema.extend({
    externalId: lenientOptional(z.string()),
  }),
  url: lenientOptional(z.string().url()),
  metadata: lenientOptional(z.record(z.string(), z.unknown())),
});
