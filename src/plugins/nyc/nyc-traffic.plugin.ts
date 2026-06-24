import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * 511NY (NYSDOT) traffic event.
 *
 * Same iBI511 vendor schema as Georgia 511, with a few field differences:
 * there is no `IsFullClosure` flag, and dates are formatted "DD/MM/YYYY HH:MM:SS".
 *
 * @see https://511ny.org/developers
 */
interface NY511Event {
  ID: number | string;
  RoadwayName?: string;
  DirectionOfTravel?: string;
  Description?: string;
  Reported?: string;
  LastUpdated?: string;
  StartDate?: string;
  PlannedEndDate?: string;
  LanesAffected?: string;
  LanesStatus?: string;
  Latitude?: number;
  Longitude?: number;
  EventType?: string; // roadwork | accidentsAndIncidents | closures | specialEvents | ...
  EventSubType?: string;
  Severity?: string; // "Minor" | "Moderate" | "Major" | "Severe" | "Unknown" | numeric
  PrimaryLocation?: string;
  SecondaryLocation?: string;
  Location?: string;
  CountyName?: string;
  RegionName?: string;
}

/**
 * NYC Traffic plugin configuration.
 */
export interface NYCTrafficPluginConfig extends BasePluginConfig {
  /** Include road construction / roadwork events. Default: true */
  includeConstruction?: boolean;
  /** Include closures only (filter out minor events). Default: false */
  closuresOnly?: boolean;
}

/**
 * New York City center coordinates (Midtown/Manhattan).
 */
const NYC_CENTER = {
  latitude: 40.73,
  longitude: -73.99,
};

/**
 * Coverage radius in meters (~30km covers the five boroughs, the Financial
 * District and Hudson Yards, and the JFK feeder highways — Van Wyck
 * Expressway, Belt Parkway, Rockaway Freeway).
 */
const COVERAGE_RADIUS_METERS = 30_000;

/**
 * 511NY EventType to risk level mapping.
 */
const EVENT_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  accidentsandincidents: 'high',
  closures: 'severe',
  roadwork: 'moderate',
  construction: 'moderate',
  specialevents: 'moderate',
  weatherevents: 'high',
  winterweatherevents: 'high',
};

/**
 * 511NY word/numeric severity to risk level (overrides the event-type default
 * when present and not "Unknown").
 */
const SEVERITY_RISK_MAP: Record<string, RiskLevel> = {
  minor: 'low',
  moderate: 'moderate',
  major: 'high',
  severe: 'severe',
  '1': 'low',
  '2': 'moderate',
  '3': 'high',
  '4': 'severe',
};

/**
 * Plugin that fetches traffic incidents, closures, and construction for the
 * NYC metro from New York State DOT's 511 system.
 *
 * No API key required — 511NY exposes a public, statewide events endpoint;
 * this plugin filters it to the NYC coverage area.
 *
 * @see https://511ny.org/developers
 */
export class NYCTrafficPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'nyc-traffic',
    name: 'NYC Traffic (511NY)',
    version: '1.0.0',
    description: 'Traffic incidents, road closures, and construction for the NYC metro',
    coverage: {
      type: 'regional',
      center: NYC_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'New York City — five boroughs, Financial District, Hudson Yards, JFK corridors',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: true,
      dataLagMinutes: 5,
      futureLookaheadMinutes: 10080, // 7 days for scheduled construction
      freshnessDescription: 'Near real-time, scheduled closures up to 7 days ahead',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['traffic'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
    defaultRadiusMeters: 5_000,
  };

  private trafficConfig: NYCTrafficPluginConfig;

  constructor(config?: NYCTrafficPluginConfig) {
    super(config);
    this.trafficConfig = {
      includeConstruction: true,
      closuresOnly: false,
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
        () => this.fetchTrafficEvents(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('NYC Traffic fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch traffic events from the 511NY statewide events endpoint and filter
   * to the query area.
   */
  private async fetchTrafficEvents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const url = 'https://511ny.org/api/getevents?format=json';

    try {
      const events = await this.fetchJson<NY511Event[]>(url);

      if (!events || !Array.isArray(events)) {
        return [];
      }

      const startTime = new Date(timeRange.start).getTime();
      const endTime = new Date(timeRange.end).getTime();

      const filtered = events.filter((event) => {
        if (typeof event.Latitude !== 'number' || typeof event.Longitude !== 'number') {
          return false;
        }

        // Filter by location
        const distance = this.calculateDistance(
          location.latitude,
          location.longitude,
          event.Latitude,
          event.Longitude
        );
        if (distance > radiusMeters) return false;

        // Filter by time range (event window overlaps query window)
        const evStart = this.parseDate(event.StartDate ?? event.Reported);
        const evEnd = this.parseDate(event.PlannedEndDate) ?? Date.now();
        if (evStart !== null && (evEnd < startTime || evStart > endTime)) {
          return false;
        }

        const eventType = this.normalizeType(event.EventType);

        // Filter construction if not configured
        if (!this.trafficConfig.includeConstruction && (eventType === 'roadwork' || eventType === 'construction')) {
          return false;
        }

        // Closures only
        if (this.trafficConfig.closuresOnly && eventType !== 'closures' && !this.isFullClosure(event)) {
          return false;
        }

        return true;
      });

      return filtered.map((event) => this.transformEvent(event));
    } catch (error) {
      warnings.push(
        `Failed to fetch NYC (511NY) traffic events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Transform a 511NY event to our Alert format.
   */
  private transformEvent(event: NY511Event) {
    const riskLevel = this.mapEventToRisk(event);
    const reported = this.parseDate(event.Reported) ?? this.parseDate(event.StartDate) ?? Date.now();
    const start = this.parseDate(event.StartDate) ?? reported;
    const end = this.parseDate(event.PlannedEndDate);

    return this.createAlert({
      id: `nyc-traffic-${event.ID}`,
      externalId: String(event.ID),
      title: this.buildTitle(event),
      description: this.buildDescription(event),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'traffic',
      temporalType: start > Date.now() ? 'scheduled' : 'real-time',
      location: {
        point: { latitude: event.Latitude!, longitude: event.Longitude! },
        address: event.RoadwayName ?? event.PrimaryLocation ?? event.Location,
        city: this.countyToCity(event.CountyName),
        state: 'NY',
      },
      timestamps: {
        issued: new Date(reported).toISOString(),
        eventStart: new Date(start).toISOString(),
        eventEnd: end ? new Date(end).toISOString() : undefined,
      },
      metadata: {
        eventType: event.EventType,
        eventSubType: event.EventSubType,
        roadway: event.RoadwayName,
        direction: event.DirectionOfTravel,
        lanesAffected: event.LanesAffected,
        lanesStatus: event.LanesStatus,
        severity: event.Severity,
        county: event.CountyName,
        region: event.RegionName,
        primaryLocation: event.PrimaryLocation,
        secondaryLocation: event.SecondaryLocation,
      },
    });
  }

  /**
   * Map a 511NY event to a risk level. A full closure or an explicit (non-
   * "Unknown") severity takes precedence over the event-type default.
   */
  private mapEventToRisk(event: NY511Event): RiskLevel {
    if (this.isFullClosure(event)) return 'severe';

    const severity = (event.Severity ?? '').trim().toLowerCase();
    if (severity && severity !== 'unknown' && SEVERITY_RISK_MAP[severity]) {
      return SEVERITY_RISK_MAP[severity];
    }

    const type = this.normalizeType(event.EventType);
    return EVENT_TYPE_RISK_MAP[type] ?? 'moderate';
  }

  /**
   * 511NY has no IsFullClosure flag; infer it from EventType / LanesStatus.
   */
  private isFullClosure(event: NY511Event): boolean {
    if (this.normalizeType(event.EventType) === 'closures') {
      const lanes = (event.LanesStatus ?? '').toLowerCase();
      // "closures" with all lanes closed, or no qualifying lane status
      return lanes.includes('closed') || lanes === '';
    }
    return false;
  }

  /**
   * Normalize an EventType to a lowercase, punctuation-free key.
   */
  private normalizeType(eventType?: string): string {
    return (eventType ?? '').toLowerCase().replace(/[^a-z]/g, '');
  }

  /**
   * Build event title.
   */
  private buildTitle(event: NY511Event): string {
    const typeLabel = this.formatType(event.EventType);
    const road = event.RoadwayName ? ` on ${event.RoadwayName}` : '';
    return `${typeLabel}${road}`;
  }

  /**
   * Format an EventType for display.
   */
  private formatType(eventType?: string): string {
    switch (this.normalizeType(eventType)) {
      case 'accidentsandincidents':
        return 'Traffic Incident';
      case 'closures':
        return 'Road Closure';
      case 'roadwork':
      case 'construction':
        return 'Road Construction';
      case 'specialevents':
        return 'Special Event';
      case 'weatherevents':
      case 'winterweatherevents':
        return 'Weather Event';
      default:
        return eventType ?? 'Traffic Event';
    }
  }

  /**
   * Build description from event data.
   */
  private buildDescription(event: NY511Event): string {
    const parts: string[] = [];

    if (event.Description) parts.push(event.Description);
    if (event.RoadwayName) {
      parts.push(`Roadway: ${event.RoadwayName}${event.DirectionOfTravel ? ` (${event.DirectionOfTravel})` : ''}`);
    }
    if (event.PrimaryLocation) parts.push(`Location: ${event.PrimaryLocation}`);
    if (event.LanesAffected) parts.push(`Lanes Affected: ${event.LanesAffected}`);
    if (event.LanesStatus) parts.push(`Lane Status: ${event.LanesStatus}`);
    if (this.isFullClosure(event)) parts.push('Full Closure: Yes');
    if (event.CountyName) parts.push(`County: ${event.CountyName}`);

    return parts.join('\n');
  }

  /**
   * Map an NYC-metro county name to a borough/city label.
   */
  private countyToCity(county?: string): string {
    const map: Record<string, string> = {
      'new york': 'Manhattan',
      kings: 'Brooklyn',
      queens: 'Queens',
      bronx: 'Bronx',
      richmond: 'Staten Island',
    };
    return map[(county ?? '').toLowerCase()] ?? 'New York';
  }

  /**
   * Parse a 511NY date string ("DD/MM/YYYY HH:MM:SS"), falling back to native
   * Date parsing. Returns epoch milliseconds, or null if unparseable.
   */
  private parseDate(value?: string): number | null {
    if (!value) return null;

    const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      const [, dd, mm, yyyy, hh, min, ss] = match;
      const ms = Date.UTC(
        Number(yyyy),
        Number(mm) - 1,
        Number(dd),
        Number(hh),
        Number(min),
        Number(ss)
      );
      return Number.isNaN(ms) ? null : ms;
    }

    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
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

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}
