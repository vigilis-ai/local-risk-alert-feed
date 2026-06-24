import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * 511NJ (NJDOT) traffic event — same iBI511 vendor schema as 511NY / Georgia
 * 511 (events endpoint). Field names mirror 511NY; dates may be epoch or
 * "DD/MM/YYYY HH:MM:SS", both handled by parseDate().
 *
 * @see https://511nj.org/developers
 */
interface NJ511Event {
  ID: number | string;
  RoadwayName?: string;
  DirectionOfTravel?: string;
  Description?: string;
  Reported?: string | number;
  LastUpdated?: string | number;
  StartDate?: string | number;
  PlannedEndDate?: string | number;
  LanesAffected?: string;
  LanesStatus?: string;
  Latitude?: number;
  Longitude?: number;
  EventType?: string;
  EventSubType?: string;
  Severity?: string;
  PrimaryLocation?: string;
  SecondaryLocation?: string;
  Location?: string;
  CountyName?: string;
  RegionName?: string;
}

/**
 * NJ Traffic plugin configuration.
 */
export interface NJTrafficPluginConfig extends BasePluginConfig {
  /**
   * 511NJ developer API key. Falls back to the NEW_JERSEY_511_API_KEY
   * environment variable. Request one at https://511nj.org/developers
   */
  apiKey?: string;
  /** Include road construction / roadwork events. Default: true */
  includeConstruction?: boolean;
  /** Include closures only (filter out minor events). Default: false */
  closuresOnly?: boolean;
}

/**
 * Jersey City, NJ center coordinates (directly across the Hudson from Lower
 * Manhattan / the Financial District).
 */
const JERSEY_CITY_CENTER = {
  latitude: 40.7178,
  longitude: -74.0431,
};

/**
 * Coverage radius in meters (~25km covers Jersey City, Hoboken, Newark,
 * Newark Liberty (EWR), and the Hudson/Bayonne crossings into Manhattan).
 */
const COVERAGE_RADIUS_METERS = 25_000;

const EVENT_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  accidentsandincidents: 'high',
  closures: 'severe',
  roadwork: 'moderate',
  construction: 'moderate',
  specialevents: 'moderate',
  weatherevents: 'high',
  winterweatherevents: 'high',
};

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
 * Jersey City / northern NJ area from NJDOT's 511NJ system.
 *
 * Requires a free 511NJ developer API key. This is the live-data path for
 * Jersey City — its municipal open-data portal has no real-time crime/traffic
 * API (only 2014-2017 snapshots), and NYPD/NYC data does not cover NJ.
 *
 * NOTE: 511NJ shares the iBI511 events schema verified for 511NY; field
 * handling mirrors NYCTrafficPlugin. Validate the first keyed response in case
 * NJ exposes minor field-name differences (the plugin degrades gracefully —
 * unparseable records are skipped, not thrown).
 *
 * @see https://511nj.org/developers
 */
export class NJTrafficPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'nj-traffic',
    name: 'New Jersey Traffic (511NJ)',
    version: '1.0.0',
    description: 'Traffic incidents, closures, and construction for Jersey City / northern NJ',
    coverage: {
      type: 'regional',
      center: JERSEY_CITY_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Jersey City, Hoboken, Newark (EWR) and Hudson crossings',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: true,
      dataLagMinutes: 5,
      futureLookaheadMinutes: 10080,
      freshnessDescription: 'Near real-time, scheduled closures up to 7 days ahead',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['traffic'],
    refreshIntervalMs: 5 * 60 * 1000,
    defaultRadiusMeters: 5_000,
  };

  private trafficConfig: NJTrafficPluginConfig;
  private apiKey: string;

  constructor(config?: NJTrafficPluginConfig) {
    super(config);
    const apiKey = config?.apiKey ?? process.env.NEW_JERSEY_511_API_KEY;
    if (!apiKey) {
      throw new Error(
        'NJ 511 API key is required (pass config.apiKey or set NEW_JERSEY_511_API_KEY)'
      );
    }
    this.apiKey = apiKey;
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
      console.error('NJ Traffic fetch error:', error);
      throw error;
    }
  }

  private async fetchTrafficEvents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const url = new URL('https://511nj.org/api/getevents');
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('format', 'json');

    try {
      const events = await this.fetchJson<NJ511Event[]>(url.toString());
      if (!events || !Array.isArray(events)) {
        return [];
      }

      const startTime = new Date(timeRange.start).getTime();
      const endTime = new Date(timeRange.end).getTime();

      const filtered = events.filter((event) => {
        if (typeof event.Latitude !== 'number' || typeof event.Longitude !== 'number') {
          return false;
        }

        const distance = this.calculateDistance(
          location.latitude,
          location.longitude,
          event.Latitude,
          event.Longitude
        );
        if (distance > radiusMeters) return false;

        const evStart = this.parseDate(event.StartDate ?? event.Reported);
        const evEnd = this.parseDate(event.PlannedEndDate) ?? Date.now();
        if (evStart !== null && (evEnd < startTime || evStart > endTime)) {
          return false;
        }

        const eventType = this.normalizeType(event.EventType);
        if (!this.trafficConfig.includeConstruction && (eventType === 'roadwork' || eventType === 'construction')) {
          return false;
        }
        if (this.trafficConfig.closuresOnly && eventType !== 'closures' && !this.isFullClosure(event)) {
          return false;
        }

        return true;
      });

      return filtered.map((event) => this.transformEvent(event));
    } catch (error) {
      warnings.push(
        `Failed to fetch NJ (511NJ) traffic events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  private transformEvent(event: NJ511Event) {
    const riskLevel = this.mapEventToRisk(event);
    const reported = this.parseDate(event.Reported) ?? this.parseDate(event.StartDate) ?? Date.now();
    const start = this.parseDate(event.StartDate) ?? reported;
    const end = this.parseDate(event.PlannedEndDate);

    return this.createAlert({
      id: `nj-traffic-${event.ID}`,
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
        city: event.CountyName ? this.titleCase(event.CountyName) : 'Jersey City',
        state: 'NJ',
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
      },
    });
  }

  private mapEventToRisk(event: NJ511Event): RiskLevel {
    if (this.isFullClosure(event)) return 'severe';
    const severity = (event.Severity ?? '').trim().toLowerCase();
    if (severity && severity !== 'unknown' && SEVERITY_RISK_MAP[severity]) {
      return SEVERITY_RISK_MAP[severity];
    }
    const type = this.normalizeType(event.EventType);
    return EVENT_TYPE_RISK_MAP[type] ?? 'moderate';
  }

  private isFullClosure(event: NJ511Event): boolean {
    if (this.normalizeType(event.EventType) === 'closures') {
      const lanes = (event.LanesStatus ?? '').toLowerCase();
      return lanes.includes('closed') || lanes === '';
    }
    return false;
  }

  private normalizeType(eventType?: string): string {
    return (eventType ?? '').toLowerCase().replace(/[^a-z]/g, '');
  }

  private buildTitle(event: NJ511Event): string {
    const typeLabel = this.formatType(event.EventType);
    const road = event.RoadwayName ? ` on ${event.RoadwayName}` : '';
    return `${typeLabel}${road}`;
  }

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

  private buildDescription(event: NJ511Event): string {
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

  private titleCase(text: string): string {
    return text
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(' ');
  }

  /**
   * Parse a 511 date — epoch (s/ms) or "DD/MM/YYYY HH:MM:SS" — to epoch ms.
   */
  private parseDate(value?: string | number): number | null {
    if (value === undefined || value === null || value === '') return null;

    if (typeof value === 'number') {
      return value < 1e12 ? value * 1000 : value;
    }

    const dmy = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (dmy) {
      const [, dd, mm, yyyy, hh, min, ss] = dmy;
      const ms = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss));
      return Number.isNaN(ms) ? null : ms;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
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
