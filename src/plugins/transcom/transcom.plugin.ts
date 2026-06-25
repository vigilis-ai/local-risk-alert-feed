import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * ============================================================================
 * SCAFFOLD — schema NOT yet verified against the live TRANSCOM feed.
 * ============================================================================
 *
 * TRANSCOM is the cross-Hudson aggregator covering 29 counties in NY/NJ/CT,
 * folding in NYC DOT, NYPD, the Port Authority, PATH, NJ Transit/Turnpike/DOT,
 * MTA, and CT DOT. It is the single feed that crosses the state line NYPD/NYC
 * open data can't, and it carries the Port Authority/PATH content we'd
 * otherwise have to scrape.
 *
 * Access requires free registration + Terms-of-Service acceptance at
 * https://data.xcmdata.org/DEWeb/Pages/index.jsp (support:
 * isgsupport@infosenseglobal.com). The exact event-feed URL and the XML element
 * names are only available after approval, so this file is a working pipeline
 * with the data-source-specific bits isolated and clearly marked:
 *
 *   1. Set `feedUrl` (config or TRANSCOM_FEED_URL) to the registered endpoint.
 *   2. Set `apiKey` (config or TRANSCOM_API_KEY) if the feed uses a key param.
 *   3. Confirm the field names in `EVENT_FIELD_CANDIDATES` / `extractEvents`
 *      against one real sample record, then delete this banner.
 *
 * Everything else (location/time filtering, risk mapping, Alert shaping) is
 * production-ready and shared with the other plugins.
 *
 * @see https://data.xcmdata.org/
 * @see https://511ny.org/developers/resources
 */

/**
 * Candidate XML field names for each logical event property. The live TRANSCOM
 * schema uses ONE of these per property — the tolerant `pick()` lookup tries
 * them in order so the first real sample tells us which to keep. Add/reporder
 * once verified.
 */
const EVENT_FIELD_CANDIDATES = {
  id: ['id', 'ID', 'eventId', 'EventID', 'EventId'],
  type: ['type', 'eventType', 'EventType', 'category', 'EventCategory'],
  subtype: ['subtype', 'eventSubType', 'EventSubType'],
  latitude: ['latitude', 'Latitude', 'lat', 'Lat'],
  longitude: ['longitude', 'Longitude', 'lng', 'lon', 'Long', 'Lon'],
  roadway: ['roadwayName', 'RoadwayName', 'facility', 'Facility', 'roadway', 'Roadway'],
  direction: ['direction', 'Direction', 'directionOfTravel', 'DirectionOfTravel'],
  description: ['description', 'Description', 'fullDescription', 'summary', 'Summary'],
  severity: ['severity', 'Severity', 'impact', 'Impact'],
  start: ['startTime', 'StartTime', 'startDate', 'StartDate', 'createTime', 'reported', 'Reported'],
  end: ['endTime', 'EndTime', 'plannedEndDate', 'PlannedEndDate', 'estimatedEnd'],
  organization: ['organization', 'Organization', 'source', 'Source', 'agency', 'Agency', 'reportingOrganization'],
  county: ['county', 'County', 'countyName', 'CountyName'],
  state: ['state', 'State'],
} as const;

/**
 * Logical normalized event, independent of the raw XML field names.
 */
interface TranscomEvent {
  id: string;
  type?: string;
  subtype?: string;
  latitude?: number;
  longitude?: number;
  roadway?: string;
  direction?: string;
  description?: string;
  severity?: string;
  start?: number;
  end?: number;
  organization?: string;
  county?: string;
  state?: string;
}

/**
 * TRANSCOM plugin configuration.
 */
export interface TRANSCOMPluginConfig extends BasePluginConfig {
  /**
   * The registered TRANSCOM event-feed URL (XML). Falls back to TRANSCOM_FEED_URL.
   * Required — there is no public default; you get this after registering at
   * https://data.xcmdata.org/.
   */
  feedUrl?: string;
  /**
   * API key/token, if the feed authenticates via a query parameter. Falls back
   * to TRANSCOM_API_KEY. Omit if access is granted via the URL itself.
   */
  apiKey?: string;
  /** Query-param name for the key (some iBI511-style feeds use `key`). Default: 'key'. */
  apiKeyParam?: string;
  /** Include planned/scheduled construction & special events. Default: true */
  includePlanned?: boolean;
}

/**
 * Tri-state region center (NYC metro) and radius covering the ~29-county
 * TRANSCOM region (NJ, NYC, Long Island, Hudson Valley, SW Connecticut).
 */
const TRANSCOM_CENTER = {
  latitude: 40.73,
  longitude: -73.99,
};
const COVERAGE_RADIUS_METERS = 120_000;

/**
 * Map a TRANSCOM severity/impact token to a risk level. VERIFY the real tokens
 * (numeric vs words) against a sample and extend. Exported for testing.
 */
export function mapTranscomSeverity(severity?: string): RiskLevel {
  const s = (severity ?? '').trim().toLowerCase();
  switch (s) {
    case 'severe':
    case 'major':
    case '4':
      return 'severe';
    case 'high':
    case '3':
      return 'high';
    case 'moderate':
    case 'medium':
    case '2':
      return 'moderate';
    case 'minor':
    case 'low':
    case '1':
      return 'low';
    default:
      return 'moderate';
  }
}

/**
 * Event-type to risk fallback when no explicit severity is present.
 */
const EVENT_TYPE_RISK: Record<string, RiskLevel> = {
  accident: 'high',
  incident: 'high',
  crash: 'high',
  closure: 'severe',
  closed: 'severe',
  construction: 'moderate',
  roadwork: 'moderate',
  'special event': 'moderate',
  'special events': 'moderate',
  weather: 'high',
  congestion: 'low',
  delay: 'low',
};

/**
 * Plugin that aggregates real-time NY/NJ/CT transportation events from the
 * TRANSCOM Data Exchange — including Port Authority and PATH content not
 * available from NYC/NYPD open data.
 */
export class TRANSCOMPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'transcom',
    name: 'TRANSCOM (NY/NJ/CT Events)',
    version: '0.1.0',
    description: 'Real-time tri-state transportation events (incl. Port Authority, PATH, NJ agencies)',
    coverage: {
      type: 'regional',
      center: TRANSCOM_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'TRANSCOM region — 29 counties across NY, NJ, and CT',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: true,
      dataLagMinutes: 5,
      futureLookaheadMinutes: 10080,
      freshnessDescription: 'Near real-time, scheduled events up to 7 days ahead',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['traffic'],
    refreshIntervalMs: 5 * 60 * 1000,
    defaultRadiusMeters: 10_000,
  };

  private transcomConfig: TRANSCOMPluginConfig;
  private feedUrl: string;
  private apiKey?: string;

  constructor(config?: TRANSCOMPluginConfig) {
    super(config);
    const feedUrl = config?.feedUrl ?? process.env.TRANSCOM_FEED_URL;
    if (!feedUrl) {
      throw new Error(
        'TRANSCOM feed URL is required (pass config.feedUrl or set TRANSCOM_FEED_URL). ' +
          'Register at https://data.xcmdata.org/ to obtain it.'
      );
    }
    this.feedUrl = feedUrl;
    this.apiKey = config?.apiKey ?? process.env.TRANSCOM_API_KEY;
    this.transcomConfig = {
      apiKeyParam: 'key',
      includePlanned: true,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters, timeRange } = options;
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchEvents(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('TRANSCOM fetch error:', error);
      throw error;
    }
  }

  private buildUrl(): string {
    const url = new URL(this.feedUrl);
    if (this.apiKey && this.transcomConfig.apiKeyParam) {
      url.searchParams.set(this.transcomConfig.apiKeyParam, this.apiKey);
    }
    return url.toString();
  }

  private async fetchEvents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    try {
      const parsed = await this.fetchXml<Record<string, unknown>>(this.buildUrl());
      const rawEvents = this.extractEvents(parsed);

      if (rawEvents.length === 0) {
        warnings.push(
          'TRANSCOM returned no parseable events — verify the feed root/field names against a real sample (see EVENT_FIELD_CANDIDATES).'
        );
        return [];
      }

      const startTime = new Date(timeRange.start).getTime();
      const endTime = new Date(timeRange.end).getTime();

      const alerts = [];
      for (const raw of rawEvents) {
        const ev = this.normalizeEvent(raw);
        if (ev.latitude === undefined || ev.longitude === undefined) continue;

        // Location filter
        const dist = this.calculateDistance(location.latitude, location.longitude, ev.latitude, ev.longitude);
        if (dist > radiusMeters) continue;

        // Time filter (overlap), when timestamps are present
        if (ev.start !== undefined) {
          const evEnd = ev.end ?? Date.now();
          if (evEnd < startTime || ev.start > endTime) continue;
        }

        // Planned filter
        if (!this.transcomConfig.includePlanned && this.isPlanned(ev)) continue;

        alerts.push(this.transformEvent(ev));
      }

      return alerts;
    } catch (error) {
      warnings.push(
        `Failed to fetch TRANSCOM events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Locate the array of raw event objects within the parsed XML. TRANSCOM/RSS
   * feeds nest events differently; try the common shapes. VERIFY against the
   * real feed and keep the matching path.
   */
  private extractEvents(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
    const candidates = [
      ['EventList', 'Event'],
      ['events', 'event'],
      ['Events', 'Event'],
      ['rss', 'channel', 'item'], // RSS form
      ['feed', 'entry'], // Atom form
    ];

    for (const path of candidates) {
      let node: unknown = parsed;
      for (const key of path) {
        if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
          node = (node as Record<string, unknown>)[key];
        } else {
          node = undefined;
          break;
        }
      }
      if (node) return Array.isArray(node) ? (node as Array<Record<string, unknown>>) : [node as Record<string, unknown>];
    }
    return [];
  }

  /**
   * Pull a value from a raw event by trying candidate field names in order.
   */
  private pick(raw: Record<string, unknown>, candidates: readonly string[]): string | undefined {
    for (const key of candidates) {
      const v = raw[key];
      if (v !== undefined && v !== null && v !== '') {
        return typeof v === 'object' ? String((v as { '#text'?: unknown })['#text'] ?? '') : String(v);
      }
    }
    return undefined;
  }

  /**
   * Convert a raw event object into the normalized shape. This is the ONE place
   * tied to the TRANSCOM schema — adjust EVENT_FIELD_CANDIDATES once verified.
   */
  private normalizeEvent(raw: Record<string, unknown>): TranscomEvent {
    const f = EVENT_FIELD_CANDIDATES;
    const lat = this.pick(raw, f.latitude);
    const lng = this.pick(raw, f.longitude);
    return {
      id: this.pick(raw, f.id) ?? `${this.pick(raw, f.roadway) ?? 'event'}-${this.pick(raw, f.start) ?? ''}`,
      type: this.pick(raw, f.type),
      subtype: this.pick(raw, f.subtype),
      latitude: lat !== undefined ? Number(lat) : undefined,
      longitude: lng !== undefined ? Number(lng) : undefined,
      roadway: this.pick(raw, f.roadway),
      direction: this.pick(raw, f.direction),
      description: this.pick(raw, f.description),
      severity: this.pick(raw, f.severity),
      start: this.parseDate(this.pick(raw, f.start)),
      end: this.parseDate(this.pick(raw, f.end)),
      organization: this.pick(raw, f.organization),
      county: this.pick(raw, f.county),
      state: this.pick(raw, f.state),
    };
  }

  private isPlanned(ev: TranscomEvent): boolean {
    const t = `${ev.type ?? ''} ${ev.subtype ?? ''}`.toLowerCase();
    return t.includes('construction') || t.includes('roadwork') || t.includes('planned') || t.includes('special event');
  }

  private transformEvent(ev: TranscomEvent) {
    const riskLevel = this.riskFor(ev);
    const reported = ev.start ?? Date.now();

    return this.createAlert({
      id: `transcom-${ev.id}`,
      externalId: ev.id,
      title: this.buildTitle(ev),
      description: this.buildDescription(ev),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'traffic',
      temporalType: ev.start !== undefined && ev.start > Date.now() ? 'scheduled' : 'real-time',
      location: {
        point: { latitude: ev.latitude!, longitude: ev.longitude! },
        address: ev.roadway,
        city: ev.county,
        state: ev.state,
      },
      timestamps: {
        issued: new Date(reported).toISOString(),
        eventStart: new Date(reported).toISOString(),
        eventEnd: ev.end ? new Date(ev.end).toISOString() : undefined,
      },
      metadata: {
        eventType: ev.type,
        subtype: ev.subtype,
        roadway: ev.roadway,
        direction: ev.direction,
        severity: ev.severity,
        organization: ev.organization,
        county: ev.county,
        state: ev.state,
      },
    });
  }

  private riskFor(ev: TranscomEvent): RiskLevel {
    if (ev.severity) return mapTranscomSeverity(ev.severity);
    const t = `${ev.type ?? ''} ${ev.subtype ?? ''}`.toLowerCase().trim();
    for (const [key, risk] of Object.entries(EVENT_TYPE_RISK)) {
      if (t.includes(key)) return risk;
    }
    return 'moderate';
  }

  private buildTitle(ev: TranscomEvent): string {
    const type = ev.type ? this.titleCase(ev.type) : 'Traffic Event';
    return ev.roadway ? `${type} on ${ev.roadway}` : type;
  }

  private buildDescription(ev: TranscomEvent): string {
    const parts: string[] = [];
    if (ev.description) parts.push(ev.description);
    if (ev.roadway) parts.push(`Roadway: ${ev.roadway}${ev.direction ? ` (${ev.direction})` : ''}`);
    if (ev.organization) parts.push(`Source: ${ev.organization}`);
    if (ev.county || ev.state) parts.push(`Location: ${[ev.county, ev.state].filter(Boolean).join(', ')}`);
    return parts.join('\n') || (ev.type ?? 'TRANSCOM event');
  }

  private titleCase(text: string): string {
    return text
      .toLowerCase()
      .split(/[\s_]+/)
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(' ');
  }

  /**
   * Parse a date that may be epoch (s/ms), ISO, or "DD/MM/YYYY HH:MM:SS".
   * Returns epoch ms or undefined. VERIFY the real format against a sample.
   */
  private parseDate(value?: string): number | undefined {
    if (!value) return undefined;

    const dmy = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (dmy) {
      const [, dd, mm, yyyy, hh, min, ss] = dmy;
      const ms = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss));
      return Number.isNaN(ms) ? undefined : ms;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
