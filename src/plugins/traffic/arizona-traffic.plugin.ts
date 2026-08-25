import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';
import { fetchArcGisFeatures, envelopeForRadius } from '../../utils';

/**
 * ADOT traffic event structure.
 */
interface ADOTTrafficEvent {
  id: string;
  event_type: string;
  event_subtype?: string;
  severity?: string;
  headline?: string;
  description?: string;
  road_name?: string;
  direction?: string;
  from_location?: string;
  to_location?: string;
  latitude: number;
  longitude: number;
  start_time?: string;
  end_time?: string;
  /** `Reported` — per-record, and equal to `StartDate` throughout this feed. */
  reported?: string;
  /** `LastUpdated` — revision stamp. See {@link resolveAdotIssued}. */
  last_updated?: string;
  lanes_affected?: string;
  lanes_blocked?: string;
  delay_minutes?: number;
  is_major?: boolean;
}

/**
 * ADOT GeoJSON response structure.
 */
interface ADOTGeoJSONResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id?: string;
    properties: Record<string, unknown>;
    geometry: {
      type: string;
      coordinates: number[] | number[][];
    };
  }>;
}

/**
 * Arizona Traffic plugin configuration.
 */
export interface ArizonaTrafficPluginConfig extends BasePluginConfig {
  /** Include road construction events. Default: true */
  includeConstruction?: boolean;
  /** Include closures only (filter out minor events). Default: false */
  closuresOnly?: boolean;
  /** Minimum delay in minutes to include. Default: 0 */
  minDelayMinutes?: number;
  /** Records per ArcGIS page. Default: 1000 (service maxRecordCount is 2000). */
  pageSize?: number;
  /** Hard ceiling on records read across all pages. Default: 4000. */
  maxRecords?: number;
}

/**
 * Resolve the instant an ADOT event was *issued*.
 *
 * `LastUpdated` looks like the obvious choice and is not. For records with
 * `Organization = "RADS"` — the city right-of-way permits that make up the bulk
 * of Phoenix-area results — ADOT stamps `LastUpdated` with its own feed refresh
 * time, not with anything about the record. Measured against the live feed on
 * 2026-08-25, across all 2,553 events: `LastUpdated` has 948 distinct values,
 * but **1,460 of them (57%) share a single one** — and that value moves with
 * the wall clock between refreshes. Genuine ADOT highway records (US-60,
 * 101-LOOP) do carry distinct values.
 *
 * That matters because `issued` is a ranking key in
 * `AlertAggregator.scoreForTriage`: severity picks the band, `issued` orders
 * *within* it. A field that is the same constant for most of the feed — and
 * that constant is always ≈ now — makes the tiebreak a no-op and hands every
 * within-band slot to whichever record happened to sort first. Which alerts
 * survive the result limit then comes down to nothing. It also always sorts
 * *newest*, so the stamped majority outranks every honestly-dated record.
 *
 * `Reported` is the better key by a wide margin: 989 distinct values over the
 * same 2,553 records, largest tie group **60 (2.3%)** against `LastUpdated`'s
 * 1,460.
 *
 * One caveat worth stating rather than glossing: in this feed `Reported` is
 * equal to `StartDate` on 100% of records, so it is the event's own date rather
 * than an independent publication instant, and for scheduled work it is in the
 * future. That is the same trade the events plugins make — anchor `issued` on
 * the best date the record itself carries, never on the clock at fetch time.
 * A future value costs nothing downstream: `scoreForTriage` clamps `issued` to
 * `now`, and `deduplicate()` just needs it stable per record.
 *
 * `LastUpdated` stays as a fallback and is kept in `metadata.lastUpdatedAt` for
 * provenance.
 */
export function resolveAdotIssued(
  event: Pick<ADOTTrafficEvent, 'reported' | 'last_updated'>,
  now: number = Date.now()
): string {
  const reported = event.reported ? Date.parse(event.reported) : NaN;
  if (Number.isFinite(reported)) {
    return new Date(reported).toISOString();
  }

  const updated = event.last_updated ? Date.parse(event.last_updated) : NaN;
  if (Number.isFinite(updated)) {
    return new Date(updated).toISOString();
  }

  return new Date(now).toISOString();
}

/**
 * Phoenix center coordinates.
 */
const PHOENIX_CENTER = {
  latitude: 33.4484,
  longitude: -112.074,
};

/**
 * Coverage radius in meters (covers Phoenix metro and major highways).
 */
const COVERAGE_RADIUS_METERS = 80_000;

/**
 * Event type to risk level mapping.
 */
const EVENT_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  // High severity
  CLOSURE: 'severe',
  CLOSED: 'severe',
  'FULL CLOSURE': 'extreme',
  'MAJOR ACCIDENT': 'severe',
  'MULTI-VEHICLE ACCIDENT': 'severe',
  FATALITY: 'extreme',
  'WRONG WAY DRIVER': 'extreme',

  // Medium severity
  ACCIDENT: 'high',
  CRASH: 'high',
  INCIDENT: 'high',
  'LANE CLOSURE': 'high',
  'LANES BLOCKED': 'high',
  DEBRIS: 'moderate',
  'DISABLED VEHICLE': 'moderate',
  CONSTRUCTION: 'moderate',
  ROADWORK: 'moderate',

  // Lower severity
  CONGESTION: 'moderate',
  'SLOW TRAFFIC': 'low',
  EVENT: 'low',
  'SPECIAL EVENT': 'moderate',
  WEATHER: 'high',
  'DUST STORM': 'severe',
  FLOODING: 'severe',
};

/**
 * Plugin that fetches traffic incident data for Arizona.
 *
 * Uses ADOT (Arizona DOT) data feeds for traffic incidents,
 * road closures, construction, and congestion information.
 *
 * @see https://az511.gov
 */
export class ArizonaTrafficPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'arizona-traffic',
    health: { expectsData: true },
    name: 'Arizona Traffic',
    version: '1.0.0',
    description: 'Traffic incidents, road closures, and construction for Arizona',
    coverage: {
      type: 'regional',
      center: PHOENIX_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Phoenix metropolitan area and major Arizona highways',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: true,
      dataLagMinutes: 10, // Near real-time with ~10 minute delay
      futureLookaheadMinutes: 10080, // 7 days for scheduled construction
      freshnessDescription: 'Near real-time, scheduled closures up to 7 days ahead',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['traffic'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
    defaultRadiusMeters: 10_000,
  };

  private trafficConfig: ArizonaTrafficPluginConfig;

  constructor(config?: ArizonaTrafficPluginConfig) {
    super(config);
    this.trafficConfig = {
      includeConstruction: true,
      closuresOnly: false,
      minDelayMinutes: 0,
      pageSize: 1000,
      maxRecords: 4000,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchTrafficEvents(options, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Arizona Traffic fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch traffic events from ADOT consolidated endpoint.
   */
  private async fetchTrafficEvents(options: PluginFetchOptions, warnings: string[]) {
    const { location, radiusMeters } = options;

    try {
      // ADOT uses a single consolidated endpoint for all traffic events.
      const events = await this.fetchFromSource(options, warnings, 'traffic');

      const filtered = events.filter((event) => {
        // Filter by location
        const distance = this.calculateDistance(
          location.latitude,
          location.longitude,
          event.latitude,
          event.longitude
        );
        if (distance > radiusMeters) return false;

        // Filter out construction if not configured
        if (!this.trafficConfig.includeConstruction) {
          const eventType = (event.event_type ?? '').toUpperCase();
          if (eventType.includes('CONSTRUCTION') || eventType.includes('ROADWORK')) {
            return false;
          }
        }

        // Filter by closures only if configured
        if (this.trafficConfig.closuresOnly) {
          const eventType = (event.event_type ?? '').toUpperCase();
          if (!eventType.includes('CLOSURE') && !eventType.includes('CLOSED')) {
            return false;
          }
        }

        // Filter by minimum delay
        if (this.trafficConfig.minDelayMinutes && event.delay_minutes) {
          if (event.delay_minutes < this.trafficConfig.minDelayMinutes) {
            return false;
          }
        }

        return true;
      });

      const alerts = filtered.map((event) => this.transformEvent(event));

      // Deduplicate by ID
      const seen = new Set<string>();
      return alerts.filter((alert) => {
        if (seen.has(alert.id)) return false;
        seen.add(alert.id);
        return true;
      });
    } catch (error) {
      warnings.push(
        `Failed to fetch traffic events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Fetch traffic events for one query location and normalize them.
   *
   * Two things used to go wrong here, both silent:
   *
   * 1. **The query was unpaged.** It asked for the whole state (`where=1=1`)
   *    and ArcGIS capped the answer at the service `maxRecordCount` of 2,000.
   *    Live on 2026-08-25 the feed held **2,559** events, so 559 were dropped
   *    before the radius filter ever ran — and nothing said so. A truncated
   *    feed and a quiet one are indistinguishable to the caller, which is
   *    exactly the failure mode that reads as "nothing happening near this
   *    site". {@link fetchArcGisFeatures} walks `resultOffset` to exhaustion
   *    and reports whether a cap stopped it, so we can warn instead.
   *
   * 2. **The whole state was pulled to serve a 10km radius.** Filtering
   *    server-side with an envelope around the query point cuts the same
   *    downtown-Phoenix query from 2,559 records to 668, and makes the cap
   *    almost impossible to hit in the first place.
   */
  private async fetchFromSource(
    options: PluginFetchOptions,
    warnings: string[],
    type: string
  ): Promise<ADOTTrafficEvent[]> {
    const { location, radiusMeters } = options;

    // ADOT Open Data Portal - Traffic Events (consolidated endpoint).
    const baseUrl =
      'https://services6.arcgis.com/clPWQMwZfdWn4MQZ/arcgis/rest/services/ADOT_Traffic_Events/FeatureServer/0/query';

    const budget = this.resolveFetchBudget(options, this.trafficConfig.maxRecords ?? 4000);

    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      f: 'geojson',
      outSR: '4326',
      // Paging is only stable under an explicit order.
      orderByFields: 'Reported DESC',
      geometry: envelopeForRadius(location.latitude, location.longitude, radiusMeters),
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
    });

    try {
      const { features, truncated } = await fetchArcGisFeatures<ADOTGeoJSONResponse['features'][number]>({
        baseUrl,
        params,
        pageSize: Math.min(this.trafficConfig.pageSize ?? 1000, budget.maxRecords),
        maxRecords: budget.maxRecords,
        fetchJson: (url) => this.fetchJson(url),
      });

      if (truncated) {
        warnings.push(
          `ADOT reported more traffic events near this location than the ${budget.maxRecords}-record ` +
            `limit allowed; only the ${budget.maxRecords} most recently reported were read. ` +
            `Narrow the radius for complete results.`
        );
      }

      return features
        .filter((feature) => feature.geometry)
        .map((feature) => this.normalizeFeature(feature, type));
    } catch (error) {
      // Surface the failure. Returning [] silently is the same "quiet feed" lie.
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`ADOT ${type} endpoint failed:`, error);
      warnings.push(`ADOT ${type} query failed: ${message}`);
      return [];
    }
  }

  /**
   * Normalize a GeoJSON feature to our traffic event structure.
   */
  private normalizeFeature(
    feature: ADOTGeoJSONResponse['features'][0],
    sourceType: string
  ): ADOTTrafficEvent {
    const props = feature.properties;

    // Extract coordinates based on geometry type
    let latitude = 0;
    let longitude = 0;

    if (feature.geometry.type === 'Point') {
      const coords = feature.geometry.coordinates as number[];
      longitude = coords[0];
      latitude = coords[1];
    } else if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiPoint') {
      // Use first coordinate
      const coords = feature.geometry.coordinates as number[][];
      if (coords.length > 0) {
        longitude = coords[0][0];
        latitude = coords[0][1];
      }
    }

    // Handle timestamp fields (ADOT uses epoch milliseconds)
    const parseTimestamp = (value: unknown): string | undefined => {
      if (typeof value === 'number') {
        return new Date(value).toISOString();
      }
      if (typeof value === 'string') {
        return value;
      }
      return undefined;
    };

    return {
      id: feature.id?.toString() ?? String(props.ObjectId ?? props.ID ?? props.OBJECTID ?? Date.now()),
      event_type: String(props.EventType ?? props.EVENT_TYPE ?? props.Type ?? sourceType).toUpperCase(),
      event_subtype: (props.EventSubType ?? props.EVENT_SUBTYPE) as string | undefined,
      severity: (props.Severity ?? props.SEVERITY) as string | undefined,
      headline: (props.HEADLINE ?? props.Title ?? props.headline) as string | undefined,
      description: (props.Description ?? props.DESCRIPTION) as string | undefined,
      road_name: (props.RoadwayName ?? props.ROAD_NAME ?? props.Route) as string | undefined,
      direction: (props.DirectionOfTravel ?? props.DIRECTION) as string | undefined,
      from_location: props.FROM_LOCATION as string | undefined,
      to_location: props.TO_LOCATION as string | undefined,
      latitude,
      longitude,
      // `Reported` stays the third-choice fallback for start_time: StartDate is
      // populated on effectively every record, so this only fires when the feed
      // gives us nothing better, and "when it was reported" is a defensible
      // stand-in for "when it started". It is now also read on its own below.
      start_time: parseTimestamp(props.StartDate ?? props.START_TIME ?? props.Reported),
      end_time: parseTimestamp(props.PlannedEndDate ?? props.END_TIME ?? props.EndDate),
      reported: parseTimestamp(props.Reported ?? props.REPORTED),
      last_updated: parseTimestamp(props.LastUpdated ?? props.LAST_UPDATED),
      lanes_affected: (props.LanesAffected ?? props.LANES_AFFECTED) as string | undefined,
      lanes_blocked: props.LANES_BLOCKED as string | undefined,
      delay_minutes: props.DELAY_MINUTES as number | undefined,
      is_major: Boolean(props.IsFullClosure ?? props.IS_MAJOR ?? props.Major),
    };
  }

  /**
   * Transform a traffic event to our Alert format.
   */
  private transformEvent(event: ADOTTrafficEvent) {
    const riskLevel = this.mapEventTypeToRisk(event.event_type, event.severity, event.is_major);
    const temporalType = event.start_time && new Date(event.start_time) > new Date() ? 'scheduled' : 'real-time';

    return this.createAlert({
      id: `az-traffic-${event.id}`,
      externalId: event.id,
      title: this.buildTitle(event),
      description: this.buildDescription(event),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'traffic',
      temporalType,
      location: {
        point: { latitude: event.latitude, longitude: event.longitude },
        address: this.buildAddress(event),
      },
      timestamps: {
        issued: resolveAdotIssued(event),
        eventStart: event.start_time,
        eventEnd: event.end_time,
      },
      metadata: {
        eventType: event.event_type,
        eventSubtype: event.event_subtype,
        reportedAt: event.reported,
        // Kept for provenance only — see resolveAdotIssued for why this is not
        // the issued time.
        lastUpdatedAt: event.last_updated,
        roadName: event.road_name,
        direction: event.direction,
        lanesAffected: event.lanes_affected,
        lanesBlocked: event.lanes_blocked,
        delayMinutes: event.delay_minutes,
        isMajor: event.is_major,
      },
    });
  }

  /**
   * Map event type to risk level.
   */
  private mapEventTypeToRisk(eventType: string, severity?: string, isMajor?: boolean): RiskLevel {
    // Check for major events first
    if (isMajor) {
      return 'severe';
    }

    // Check severity if provided
    if (severity) {
      const sev = severity.toUpperCase();
      if (sev.includes('CRITICAL') || sev.includes('EXTREME')) return 'extreme';
      if (sev.includes('MAJOR') || sev.includes('SEVERE')) return 'severe';
      if (sev.includes('MODERATE') || sev.includes('SIGNIFICANT')) return 'high';
      if (sev.includes('MINOR')) return 'moderate';
    }

    // Check event type mapping
    const normalizedType = eventType.toUpperCase();
    if (EVENT_TYPE_RISK_MAP[normalizedType]) {
      return EVENT_TYPE_RISK_MAP[normalizedType];
    }

    // Partial match
    for (const [key, risk] of Object.entries(EVENT_TYPE_RISK_MAP)) {
      if (normalizedType.includes(key)) {
        return risk;
      }
    }

    return 'moderate';
  }

  /**
   * Build title from event data.
   */
  private buildTitle(event: ADOTTrafficEvent): string {
    if (event.headline) {
      return event.headline;
    }

    const parts: string[] = [];

    // Event type
    const eventType = this.formatEventType(event.event_type);
    parts.push(eventType);

    // Road name
    if (event.road_name) {
      parts.push(`on ${event.road_name}`);
    }

    // Direction
    if (event.direction) {
      parts.push(event.direction);
    }

    return parts.join(' ');
  }

  /**
   * Format event type for display.
   */
  private formatEventType(eventType: string): string {
    return eventType
      .toLowerCase()
      .replace(/_/g, ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Build description from event data.
   */
  private buildDescription(event: ADOTTrafficEvent): string {
    const parts: string[] = [];

    if (event.description) {
      parts.push(event.description);
    }

    if (event.lanes_affected || event.lanes_blocked) {
      const lanes = event.lanes_blocked ?? event.lanes_affected;
      parts.push(`Lanes affected: ${lanes}`);
    }

    if (event.delay_minutes) {
      parts.push(`Estimated delay: ${event.delay_minutes} minutes`);
    }

    if (event.from_location && event.to_location) {
      parts.push(`From: ${event.from_location} To: ${event.to_location}`);
    }

    return parts.join('\n') || this.buildTitle(event);
  }

  /**
   * Build address from event data.
   */
  private buildAddress(event: ADOTTrafficEvent): string {
    const parts: string[] = [];

    if (event.road_name) {
      parts.push(event.road_name);
    }

    if (event.direction) {
      parts.push(event.direction);
    }

    if (event.from_location) {
      parts.push(`near ${event.from_location}`);
    }

    return parts.join(' ') || 'Arizona';
  }

  /**
   * Calculate distance between two points in meters.
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}
