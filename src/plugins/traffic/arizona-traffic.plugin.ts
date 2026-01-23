import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

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
    name: 'Arizona Traffic',
    version: '1.0.0',
    description: 'Traffic incidents, road closures, and construction for Arizona',
    coverage: {
      type: 'regional',
      center: PHOENIX_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Phoenix metropolitan area and major Arizona highways',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['traffic'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
  };

  private trafficConfig: ArizonaTrafficPluginConfig;

  constructor(config?: ArizonaTrafficPluginConfig) {
    super(config);
    this.trafficConfig = {
      includeConstruction: true,
      closuresOnly: false,
      minDelayMinutes: 0,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters } = options;
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchTrafficEvents(location, radiusMeters, warnings),
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
   * Fetch traffic events from ADOT sources.
   */
  private async fetchTrafficEvents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    warnings: string[]
  ) {
    const allAlerts: ReturnType<typeof this.transformEvent>[] = [];

    // Fetch from multiple ADOT endpoints
    const sources = [
      { url: this.buildIncidentsUrl(location), type: 'incidents' },
      { url: this.buildConstructionUrl(location), type: 'construction' },
      { url: this.buildClosuresUrl(location), type: 'closures' },
    ];

    for (const source of sources) {
      if (!this.trafficConfig.includeConstruction && source.type === 'construction') {
        continue;
      }

      try {
        const events = await this.fetchFromSource(source.url, source.type);
        const filtered = events.filter((event) => {
          // Filter by location
          const distance = this.calculateDistance(
            location.latitude,
            location.longitude,
            event.latitude,
            event.longitude
          );
          if (distance > radiusMeters) return false;

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
        allAlerts.push(...alerts);
      } catch (error) {
        warnings.push(
          `Failed to fetch ${source.type}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Deduplicate by ID
    const seen = new Set<string>();
    return allAlerts.filter((alert) => {
      if (seen.has(alert.id)) return false;
      seen.add(alert.id);
      return true;
    });
  }

  /**
   * Build URL for traffic incidents.
   * Note: Location filtering is done client-side after fetching all Arizona data.
   */
  private buildIncidentsUrl(_location: { latitude: number; longitude: number }): string {
    // ADOT Open Data Portal - Traffic Events
    // Note: This is a public GeoJSON endpoint
    return 'https://services1.arcgis.com/0MSEUqKaxRlEPj5g/arcgis/rest/services/ADOT_Traffic_Events/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson';
  }

  /**
   * Build URL for construction events.
   * Note: Location filtering is done client-side after fetching all Arizona data.
   */
  private buildConstructionUrl(_location: { latitude: number; longitude: number }): string {
    return 'https://services1.arcgis.com/0MSEUqKaxRlEPj5g/arcgis/rest/services/ADOT_Construction_Projects/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson';
  }

  /**
   * Build URL for road closures.
   * Note: Location filtering is done client-side after fetching all Arizona data.
   */
  private buildClosuresUrl(_location: { latitude: number; longitude: number }): string {
    return 'https://services1.arcgis.com/0MSEUqKaxRlEPj5g/arcgis/rest/services/ADOT_Road_Closures/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson';
  }

  /**
   * Fetch from a specific source and normalize the data.
   */
  private async fetchFromSource(url: string, type: string): Promise<ADOTTrafficEvent[]> {
    try {
      const response = await this.fetchJson<ADOTGeoJSONResponse>(url);

      if (!response.features) {
        return [];
      }

      return response.features
        .filter((feature) => feature.geometry)
        .map((feature) => this.normalizeFeature(feature, type));
    } catch (error) {
      // If the ADOT endpoint fails, try a fallback approach
      console.warn(`ADOT ${type} endpoint failed, returning empty:`, error);
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

    return {
      id: feature.id?.toString() ?? String(props.OBJECTID ?? props.id ?? Date.now()),
      event_type: String(props.EVENT_TYPE ?? props.Type ?? props.event_type ?? sourceType).toUpperCase(),
      event_subtype: props.EVENT_SUBTYPE as string | undefined,
      severity: props.SEVERITY as string | undefined,
      headline: (props.HEADLINE ?? props.Title ?? props.headline) as string | undefined,
      description: (props.DESCRIPTION ?? props.Description ?? props.description) as string | undefined,
      road_name: (props.ROAD_NAME ?? props.Route ?? props.road_name) as string | undefined,
      direction: props.DIRECTION as string | undefined,
      from_location: props.FROM_LOCATION as string | undefined,
      to_location: props.TO_LOCATION as string | undefined,
      latitude,
      longitude,
      start_time: (props.START_TIME ?? props.StartDate ?? props.start_time) as string | undefined,
      end_time: (props.END_TIME ?? props.EndDate ?? props.end_time) as string | undefined,
      last_updated: (props.LAST_UPDATED ?? props.LastUpdated ?? props.last_updated) as string | undefined,
      lanes_affected: props.LANES_AFFECTED as string | undefined,
      lanes_blocked: props.LANES_BLOCKED as string | undefined,
      delay_minutes: props.DELAY_MINUTES as number | undefined,
      is_major: Boolean(props.IS_MAJOR ?? props.Major),
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
        issued: event.last_updated ?? new Date().toISOString(),
        eventStart: event.start_time,
        eventEnd: event.end_time,
      },
      metadata: {
        eventType: event.event_type,
        eventSubtype: event.event_subtype,
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
