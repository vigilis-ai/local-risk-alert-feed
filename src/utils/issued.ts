// utils/issued.ts
//
// `Alert.timestamps.issued` is not decoration: `AlertAggregator.scoreForTriage`
// uses it as the ordering key *within* a severity band, so it decides which
// alerts survive a result limit once severity has tied.
//
// The failure mode this file exists to prevent is a plugin writing
// `issued: new Date().toISOString()`. That is the fetch time, not a property of
// the record. Every alert from that plugin then carries the same value, the
// tiebreak collapses to a no-op, and the surviving set is whatever order the
// upstream happened to return. Worse, "now" is the largest value `issued` can
// take, so a stamped feed outranks every honestly-timestamped one in its band.
//
// The same trap appears in upstream fields that merely look per-record. ADOT's
// `LastUpdated` and Socrata's `:updated_at` are both feed-refresh stamps: on
// 2026-08-25, 1,452 of 1,972 ADOT `RADS` records shared one `LastUpdated`, and
// all 2,000 sampled rows of Austin's special-events dataset shared one
// `:updated_at`. A constant that tracks the wall clock is the pathological
// case — it is `now()` wearing a field name.

/** How `issued` was arrived at, for provenance in `metadata`. */
export type IssuedBasis = 'published' | 'event-start' | 'fetch-time';

export interface ResolveIssuedOptions {
  /**
   * Genuine per-record publication instants from the source, best first.
   * A value in the future is rejected: whatever it describes, it cannot be
   * when the record was published.
   */
  published?: Array<string | number | Date | null | undefined>;
  /**
   * The event's own date. The honest last resort for a scheduled item — it is
   * at least a property of the record rather than of the request.
   */
  eventStart?: string | number | Date | null;
  now?: number;
}

function toMillis(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Resolve `issued` from the best evidence the source actually provides.
 *
 * Prefers a real publication timestamp; falls back to the event's own date;
 * uses the fetch time only when the record carries no usable date at all — at
 * which point `basis` says so, rather than the value quietly implying freshness
 * the record never had.
 *
 * Note the residual limit when `basis` is `event-start` and the event is in the
 * future: `scoreForTriage` clamps `issued` to `now`, so purely-future scheduled
 * items still tie with one another. That is better than `fetch-time` — the value
 * is no longer a claim about the record that is false — but ordering scheduled
 * events by imminence needs the aggregator to rank them on `eventStart`.
 */
export function resolveIssued(options: ResolveIssuedOptions): {
  issued: string;
  basis: IssuedBasis;
} {
  const now = options.now ?? Date.now();

  for (const candidate of options.published ?? []) {
    const ms = toMillis(candidate);
    if (Number.isFinite(ms) && ms <= now) {
      return { issued: new Date(ms).toISOString(), basis: 'published' };
    }
  }

  const start = toMillis(options.eventStart);
  if (Number.isFinite(start)) {
    return { issued: new Date(start).toISOString(), basis: 'event-start' };
  }

  return { issued: new Date(now).toISOString(), basis: 'fetch-time' };
}

/**
 * Parse Socrata's `yyyyMMddHHmmss` numeric-string date (e.g. Austin's
 * `report_date: "20191128000000"`).
 *
 * These are local wall-clock stamps with no zone; Austin is the only consumer
 * and CST/CDT vs UTC cannot move a value across the ordering of records that
 * are days apart, so they are read as UTC.
 */
export function parseSocrataNumericDate(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const digits = String(value).trim();
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(digits);
  if (!match) return undefined;

  const [, y, mo, d, h = '00', mi = '00', sec = '00'] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  if (!Number.isFinite(ms)) return undefined;

  // Reject impossible components that Date.UTC would silently roll over
  // (e.g. "20191345…" becoming 2020-01-14).
  const date = new Date(ms);
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) {
    return undefined;
  }

  return date.toISOString();
}
