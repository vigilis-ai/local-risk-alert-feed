// utils/arcgis.ts
//
// Shared helpers for the ArcGIS FeatureServer plugins.
//
// Every ArcGIS-backed plugin used to issue a single query with
// `resultRecordCount: <limit>` and `orderByFields: <date> DESC`, then filter by
// radius client-side. That silently keeps only the newest `limit` records in the
// *bounding box*, which is far larger than the requested radius. On a busy feed
// a multi-day window truncates long before the radius filter runs, so the oldest
// — and often most severe — events in the window are dropped without a trace.
//
// `fetchArcGisFeatures` pages through the full result set with `resultOffset`
// and reports whether it stopped early, so callers can warn instead of
// pretending the result is complete.

/** Metres per degree of latitude (WGS84 mean). */
const METERS_PER_DEGREE_LAT = 111_320;

/** ArcGIS `f=geojson` nests the flag under `properties`; `f=json` puts it at the root. */
interface ArcGisPagedResponse<F> {
  features?: F[];
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
}

export interface ArcGisFetchOptions {
  baseUrl: string;
  /**
   * Query params *without* `resultOffset`/`resultRecordCount` — this helper owns
   * those. Must include `orderByFields`, or ArcGIS paging is not stable.
   */
  params: URLSearchParams;
  /** Records requested per page. */
  pageSize: number;
  /** Hard ceiling across all pages, so a runaway window can't exhaust memory. */
  maxRecords: number;
  /** Bound page count independently of pageSize. */
  maxPages?: number;
  fetchJson: <T>(url: string) => Promise<T>;
}

export interface ArcGisFetchResult<F> {
  features: F[];
  /** True when `maxRecords`/`maxPages` stopped the walk while records remained. */
  truncated: boolean;
  pagesFetched: number;
}

function hasMorePages<F>(response: ArcGisPagedResponse<F>, requested: number, received: number): boolean {
  const exceeded = response.properties?.exceededTransferLimit ?? response.exceededTransferLimit;
  if (typeof exceeded === 'boolean') return exceeded;
  // No flag: a full page implies there may be another.
  return received >= requested;
}

/**
 * Page through an ArcGIS query until the result set is exhausted or a cap is hit.
 * Callers MUST surface `truncated` — that is the whole point of this helper.
 */
export async function fetchArcGisFeatures<F>(
  options: ArcGisFetchOptions,
): Promise<ArcGisFetchResult<F>> {
  const { baseUrl, params, pageSize, maxRecords, maxPages = 25, fetchJson } = options;

  const features: F[] = [];
  let pagesFetched = 0;
  let truncated = false;

  while (features.length < maxRecords && pagesFetched < maxPages) {
    const requested = Math.min(pageSize, maxRecords - features.length);

    const pageParams = new URLSearchParams(params);
    pageParams.set('resultOffset', String(features.length));
    pageParams.set('resultRecordCount', String(requested));

    const response = await fetchJson<ArcGisPagedResponse<F>>(`${baseUrl}?${pageParams}`);
    pagesFetched++;

    const page = response?.features ?? [];
    features.push(...page);

    if (!hasMorePages(response ?? {}, requested, page.length)) {
      return { features, truncated: false, pagesFetched };
    }

    // More records exist. If a cap stops us here, the caller must be told.
    if (features.length >= maxRecords || pagesFetched >= maxPages) {
      truncated = true;
    }
  }

  return { features, truncated, pagesFetched };
}

/**
 * Envelope that circumscribes a circle of `radiusMeters` around a point, as
 * `xmin,ymin,xmax,ymax` in WGS84.
 *
 * Plugins previously hardcoded ±0.12° lon / ±0.09° lat — roughly a 22km × 20km
 * box regardless of the radius asked for — which inflated the result set that
 * the record cap then truncated.
 */
export function envelopeForRadius(
  latitude: number,
  longitude: number,
  radiusMeters: number,
): string {
  const latDelta = radiusMeters / METERS_PER_DEGREE_LAT;

  // Longitude degrees shrink with latitude; guard against cos → 0 near the poles.
  const cosLat = Math.cos((latitude * Math.PI) / 180);
  const lonDelta = Math.abs(cosLat) < 1e-6
    ? 180
    : Math.min(180, radiusMeters / (METERS_PER_DEGREE_LAT * Math.abs(cosLat)));

  // 1% margin absorbs the spherical-vs-planar mismatch at the box corners.
  const latPad = latDelta * 1.01;
  const lonPad = Math.min(180, lonDelta * 1.01);

  return [
    longitude - lonPad,
    latitude - latPad,
    longitude + lonPad,
    latitude + latPad,
  ].join(',');
}

/**
 * Format an instant as an ArcGIS `TIMESTAMP` literal body (`YYYY-MM-DD HH:MM:SS`).
 *
 * Date-only literals (`DATE '2026-07-09'`) silently truncate to midnight, so an
 * `<= DATE '<today>'` bound excludes everything that happened today.
 */
export function toArcGisTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}
