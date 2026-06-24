import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Georgia 511 (GDOT) traffic event.
 *
 * @see https://511ga.org/developers/doc
 */
interface GA511Event {
  ID: number | string;
  SourceId?: string;
  Organization?: string;
  RoadwayName?: string;
  DirectionOfTravel?: string;
  Description?: string;
  Reported?: number | string;
  LastUpdated?: number | string;
  StartDate?: number | string;
  PlannedEndDate?: number | string;
  LanesAffected?: string;
  Latitude?: number;
  Longitude?: number;
  EventType?: string; // roadwork | accidentsAndIncidents | closures | specialevents | ...
  Subtype?: string;
  IsFullClosure?: boolean;
  Severity?: string; // "1".."4" or "Unknown"
  Comment?: string;
  Restrictions?: Record<string, unknown>;
  DetourInstructions?: string;
}

/**
 * Atlanta Traffic plugin configuration.
 */
export interface AtlantaTrafficPluginConfig extends BasePluginConfig {
  /**
   * Georgia 511 developer API key. Falls back to the GEORGIA_511_API_KEY
   * environment variable. Request one at https://511ga.org/developers/doc
   */
  apiKey?: string;
  /** Include road construction / roadwork events. Default: true */
  includeConstruction?: boolean;
  /** Include closures only (filter out minor events). Default: false */
  closuresOnly?: boolean;
}

/**
 * Atlanta, GA center coordinates (downtown).
 */
const ATLANTA_CENTER = {
  latitude: 33.749,
  longitude: -84.388,
};

/**
 * Coverage radius in meters (~60km covers the Atlanta metro and the major
 * interstates: I-285 perimeter, I-75, I-85, I-20, and the airport corridor).
 */
const COVERAGE_RADIUS_METERS = 60_000;

/**
 * GA511 EventType to risk level mapping.
 */
const EVENT_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  accidentsandincidents: 'high',
  closures: 'severe',
  roadwork: 'moderate',
  specialevents: 'moderate',
  weatherevents: 'high',
};

/**
 * GA511 numeric severity to risk level (used as an override when present).
 */
const SEVERITY_RISK_MAP: Record<string, RiskLevel> = {
  '1': 'low',
  '2': 'moderate',
  '3': 'high',
  '4': 'severe',
};

/**
 * Plugin that fetches traffic incidents, closures, and construction for the
 * Atlanta metro from Georgia DOT's 511 system.
 *
 * Requires a free Georgia 511 developer API key.
 *
 * @see https://511ga.org/developers/doc
 * @see https://511ga.org/help/endpoint/event
 */
export class AtlantaTrafficPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'atlanta-traffic',
    name: 'Atlanta Traffic (Georgia 511)',
    version: '1.0.0',
    description: 'Traffic incidents, road closures, and construction for the Atlanta metro',
    coverage: {
      type: 'regional',
      center: ATLANTA_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Atlanta, GA metropolitan area and major interstates',
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
    defaultRadiusMeters: 10_000,
  };

  private trafficConfig: AtlantaTrafficPluginConfig;
  private apiKey: string;

  constructor(config?: AtlantaTrafficPluginConfig) {
    super(config);
    const apiKey = config?.apiKey ?? process.env.GEORGIA_511_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Georgia 511 API key is required (pass config.apiKey or set GEORGIA_511_API_KEY)'
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
      console.error('Atlanta Traffic fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch traffic events from the GA511 Events endpoint.
   */
  private async fetchTrafficEvents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const url = new URL('https://511ga.org/api/v2/get/event');
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('format', 'json');

    try {
      const events = await this.fetchJson<GA511Event[]>(url.toString());

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
        if (evStart !== null) {
          if (evEnd < startTime || evStart > endTime) return false;
        }

        const eventType = this.normalizeType(event.EventType);

        // Filter construction if not configured
        if (!this.trafficConfig.includeConstruction && eventType === 'roadwork') {
          return false;
        }

        // Closures only
        if (this.trafficConfig.closuresOnly && !event.IsFullClosure && eventType !== 'closures') {
          return false;
        }

        return true;
      });

      return filtered.map((event) => this.transformEvent(event));
    } catch (error) {
      warnings.push(
        `Failed to fetch Atlanta (GA511) traffic events: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Transform a GA511 event to our Alert format.
   */
  private transformEvent(event: GA511Event) {
    const riskLevel = this.mapEventToRisk(event);
    const reported = this.parseDate(event.Reported) ?? this.parseDate(event.StartDate) ?? Date.now();
    const start = this.parseDate(event.StartDate) ?? reported;
    const end = this.parseDate(event.PlannedEndDate);

    return this.createAlert({
      id: `atlanta-traffic-${event.ID}`,
      externalId: String(event.ID),
      title: this.buildTitle(event),
      description: this.buildDescription(event),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'traffic',
      temporalType: end && end > Date.now() && start > Date.now() ? 'scheduled' : 'real-time',
      location: {
        point: { latitude: event.Latitude!, longitude: event.Longitude! },
        address: event.RoadwayName,
        city: 'Atlanta',
        state: 'GA',
      },
      timestamps: {
        issued: new Date(reported).toISOString(),
        eventStart: new Date(start).toISOString(),
        eventEnd: end ? new Date(end).toISOString() : undefined,
      },
      metadata: {
        eventType: event.EventType,
        subtype: event.Subtype,
        roadway: event.RoadwayName,
        direction: event.DirectionOfTravel,
        lanesAffected: event.LanesAffected,
        isFullClosure: event.IsFullClosure,
        severity: event.Severity,
        organization: event.Organization,
        detour: event.DetourInstructions,
      },
    });
  }

  /**
   * Map a GA511 event to a risk level. A full closure or an explicit numeric
   * severity takes precedence over the event-type default.
   */
  private mapEventToRisk(event: GA511Event): RiskLevel {
    if (event.IsFullClosure) return 'severe';

    const severity = (event.Severity ?? '').trim();
    if (SEVERITY_RISK_MAP[severity]) {
      return SEVERITY_RISK_MAP[severity];
    }

    const type = this.normalizeType(event.EventType);
    return EVENT_TYPE_RISK_MAP[type] ?? 'moderate';
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
  private buildTitle(event: GA511Event): string {
    const typeLabel = this.formatType(event.EventType);
    const road = event.RoadwayName ? ` on ${event.RoadwayName}` : '';
    if (event.IsFullClosure) {
      return `Full Closure${road}`;
    }
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
        return 'Road Construction';
      case 'specialevents':
        return 'Special Event';
      case 'weatherevents':
        return 'Weather Event';
      default:
        return eventType ?? 'Traffic Event';
    }
  }

  /**
   * Build description from event data.
   */
  private buildDescription(event: GA511Event): string {
    const parts: string[] = [];

    if (event.Description) {
      parts.push(event.Description);
    }
    if (event.RoadwayName) {
      parts.push(`Roadway: ${event.RoadwayName}${event.DirectionOfTravel ? ` (${event.DirectionOfTravel})` : ''}`);
    }
    if (event.LanesAffected) {
      parts.push(`Lanes Affected: ${event.LanesAffected}`);
    }
    if (event.IsFullClosure) {
      parts.push('Full Closure: Yes');
    }
    if (event.DetourInstructions) {
      parts.push(`Detour: ${event.DetourInstructions}`);
    }

    return parts.join('\n');
  }

  /**
   * Parse a GA511 date value, which may be an epoch (seconds or ms) or an
   * ISO/date string. Returns epoch milliseconds, or null if unparseable.
   */
  private parseDate(value?: number | string): number | null {
    if (value === undefined || value === null || value === '') return null;

    if (typeof value === 'number') {
      // Heuristic: values below ~10^12 are epoch seconds.
      return value < 1e12 ? value * 1000 : value;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
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
