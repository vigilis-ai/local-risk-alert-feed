import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';
import { fetchArcGisFeatures, envelopeForRadius, toArcGisTimestamp } from '../../utils/arcgis';

/**
 * Phoenix Fire incident from ArcGIS service.
 */
interface PhoenixFireIncident {
  OBJECTID: number;
  INCIDENT: string;
  CITY: string;
  FIRE_DISTRICT: string;
  COUNCIL_DISTRICT: string;
  STATION: string;
  CATEGORY: string; // ALS, BLS, FIRE, etc.
  CLASSIFICATION: string;
  /** Phoenix local time stored as epoch-as-if-UTC. Prefer `REPORTED_UTC`. */
  REPORTED: number;
  /** The same instant in real UTC (Arizona is UTC-7 year-round, no DST). */
  REPORTED_UTC?: number;
  VILLAGE: string;
  FIRST_DUE: string;
  TYPE: string; // EMS, FIRE, SERVICE
}

/**
 * ArcGIS GeoJSON response.
 */
interface ArcGISGeoJSONResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: PhoenixFireIncident;
    geometry: {
      type: 'Point';
      coordinates: [number, number]; // [lng, lat]
    };
  }>;
}

/**
 * Phoenix Fire plugin configuration.
 */
export interface PhoenixFirePluginConfig extends BasePluginConfig {
  /** Include EMS calls. Default: true */
  includeEMS?: boolean;
  /** Include service calls (non-emergency). Default: false */
  includeService?: boolean;
  /**
   * Records requested per page. Default: 1000 (layer maxRecordCount is 2000).
   * @deprecated Prefer `pageSize`; `limit` is honoured as the page size and no
   * longer caps the overall result.
   */
  limit?: number;
  /** Records requested per page. Default: 1000. */
  pageSize?: number;
  /** Ceiling across all pages for one query. Default: 5000. */
  maxRecords?: number;
}

/**
 * Arizona does not observe DST, so the layer's local-to-UTC offset is a constant
 * +7h. Used only as a fallback: `REPORTED_UTC` carries the true instant.
 */
const PHOENIX_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/** The true UTC instant an incident was reported, in epoch ms. */
export function phoenixFireUtcInstant(incident: { REPORTED: number; REPORTED_UTC?: number }): number {
  return typeof incident.REPORTED_UTC === 'number' && Number.isFinite(incident.REPORTED_UTC)
    ? incident.REPORTED_UTC
    : incident.REPORTED + PHOENIX_UTC_OFFSET_MS;
}

/**
 * Phoenix center coordinates.
 */
const PHOENIX_CENTER = {
  latitude: 33.4484,
  longitude: -112.074,
};

/**
 * Coverage radius in meters (approximately 50km covers greater Phoenix metro).
 */
const COVERAGE_RADIUS_METERS = 50_000;

/**
 * Category to risk level and alert category mapping.
 */
const CATEGORY_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  // Fire categories
  FIRE: { category: 'fire', risk: 'high' },
  'STRUCTURE FIRE': { category: 'fire', risk: 'extreme' },
  'BRUSH FIRE': { category: 'fire', risk: 'severe' },
  HAZMAT: { category: 'fire', risk: 'severe' },

  // EMS categories
  ALS: { category: 'medical', risk: 'high' }, // Advanced Life Support
  BLS: { category: 'medical', risk: 'moderate' }, // Basic Life Support
  CEMS: { category: 'medical', risk: 'moderate' }, // Community EMS

  // Service categories
  'MISC SERVICE': { category: 'fire', risk: 'low' },
  SERVICE: { category: 'fire', risk: 'low' },
};

/**
 * Plugin that fetches fire and EMS incident data from Phoenix Fire Department ArcGIS service.
 *
 * Uses the Phoenix Fire 30-day incident history which is updated frequently (data is ~1-2 days old).
 *
 * @see https://maps.phoenix.gov/phxfire/rest/services/IncidentHistory30DayPoints/MapServer
 */
export class PhoenixFirePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'phoenix-fire',
    name: 'Phoenix Fire Department',
    version: '2.0.0',
    description: 'Fire and EMS incidents from Phoenix Regional Dispatch Center',
    coverage: {
      type: 'regional',
      center: PHOENIX_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Phoenix, AZ metropolitan area (Phoenix, Paradise Valley, Laveen)',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 1440, // ~24 hour delay
      freshnessDescription: '~24 hour delay',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['fire', 'medical'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
    defaultRadiusMeters: 10_000,
  };

  private fireConfig: PhoenixFirePluginConfig;

  constructor(config?: PhoenixFirePluginConfig) {
    super(config);
    this.fireConfig = {
      includeEMS: true,
      includeService: false,
      pageSize: config?.pageSize ?? config?.limit ?? 1000,
      maxRecords: 5000,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, timeRange, radiusMeters, categories } = options;
    const cacheKey = this.generateCacheKey(options);

    try {
      // Warnings are cached with the alerts; a cache hit that dropped them would
      // report a truncated window as a complete one.
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchIncidents(location, timeRange, radiusMeters, categories),
        this.config.cacheTtlMs
      );

      return {
        alerts: data.alerts,
        fromCache,
        cacheKey,
        warnings: data.warnings.length > 0 ? data.warnings : undefined,
      };
    } catch (error) {
      console.error('Phoenix Fire fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch incidents from Phoenix Fire ArcGIS service.
   */
  private async fetchIncidents(
    location: { latitude: number; longitude: number },
    timeRange: { start: string; end: string },
    radiusMeters: number,
    categories?: AlertCategory[]
  ): Promise<{ alerts: ReturnType<PhoenixFirePlugin['transformIncident']>[]; warnings: string[] }> {
    // Phoenix Fire 30-day incident history
    const baseUrl = 'https://maps.phoenix.gov/phxfire/rest/services/IncidentHistory30DayPoints/MapServer/0/query';

    const warnings: string[] = [];

    // `REPORTED` is Phoenix local time stored as epoch-as-if-UTC; `REPORTED_UTC`
    // is the true instant. A DATE literal also truncates the upper bound to
    // midnight, excluding everything reported today.
    const start = toArcGisTimestamp(new Date(timeRange.start));
    const end = toArcGisTimestamp(new Date(timeRange.end));

    // Build type filter
    const typeFilters: string[] = ["TYPE='FIRE'"];
    if (this.fireConfig.includeEMS) {
      typeFilters.push("TYPE='EMS'");
    }
    if (this.fireConfig.includeService) {
      typeFilters.push("TYPE='SERVICE'");
    }

    const params = new URLSearchParams({
      where: `REPORTED_UTC >= TIMESTAMP '${start}' AND REPORTED_UTC <= TIMESTAMP '${end}' AND (${typeFilters.join(' OR ')})`,
      outFields: '*',
      f: 'geojson',
      outSR: '4326',
      orderByFields: 'REPORTED_UTC DESC',
      // Previously unbounded: the whole city was fetched, then the newest N kept.
      geometry: envelopeForRadius(location.latitude, location.longitude, radiusMeters),
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
    });

    const { features, truncated } = await fetchArcGisFeatures<ArcGISGeoJSONResponse['features'][number]>({
      baseUrl,
      params,
      pageSize: this.fireConfig.pageSize!,
      maxRecords: this.fireConfig.maxRecords!,
      fetchJson: (url) => this.fetchJson(url),
    });

    if (truncated) {
      warnings.push(
        `Phoenix Fire returned more than ${this.fireConfig.maxRecords} incidents for this window; ` +
          `only the ${this.fireConfig.maxRecords} most recent were read. Narrow the time range or radius for complete results.`
      );
    }

    // Transform and filter by location
    const alerts = features
      .filter(f => {
        if (!f.geometry?.coordinates) return false;

        const [lng, lat] = f.geometry.coordinates;
        const distance = this.calculateDistance(location.latitude, location.longitude, lat, lng);

        if (distance > radiusMeters) return false;

        // Filter by categories if specified
        if (categories && categories.length > 0) {
          const alertCategory = this.mapTypeToCategory(f.properties.TYPE);
          if (!categories.includes(alertCategory)) return false;
        }

        return true;
      })
      .map(f => this.transformIncident(f.properties, f.geometry.coordinates));

    return { alerts, warnings };
  }

  /**
   * Map incident type to alert category.
   */
  private mapTypeToCategory(type: string): AlertCategory {
    if (type === 'FIRE') return 'fire';
    if (type === 'EMS') return 'medical';
    return 'fire';
  }

  /**
   * Transform a Phoenix Fire incident to our Alert format.
   */
  private transformIncident(
    incident: PhoenixFireIncident,
    coordinates: [number, number]
  ) {
    const [longitude, latitude] = coordinates;
    const { category, risk } = this.mapCategoryToRisk(incident.TYPE, incident.CATEGORY);

    // `REPORTED` is local wall-clock stored as epoch-as-if-UTC, so using it
    // directly shifted every incident 7 hours earlier and mislabelled live
    // incidents as `historical`.
    const reportedAtMs = phoenixFireUtcInstant(incident);
    const issued = new Date(reportedAtMs).toISOString();

    // Determine if real-time (within last 24 hours)
    const isRecent = Date.now() - reportedAtMs < 24 * 60 * 60 * 1000;
    const temporalType = isRecent ? 'real-time' : 'historical';

    // Build title
    const title = this.buildTitle(incident.TYPE, incident.CATEGORY);

    return this.createAlert({
      id: `phoenix-fire-${incident.INCIDENT}`,
      externalId: incident.INCIDENT,
      title,
      description: this.buildDescription(incident),
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType,
      location: {
        point: { latitude, longitude },
        city: incident.CITY === 'PHX' ? 'Phoenix' : incident.CITY,
        state: 'AZ',
      },
      timestamps: {
        issued,
        eventStart: issued,
      },
      metadata: {
        incidentNumber: incident.INCIDENT,
        type: incident.TYPE,
        category: incident.CATEGORY,
        classification: incident.CLASSIFICATION,
        station: incident.STATION?.trim(),
        fireDistrict: incident.FIRE_DISTRICT,
        councilDistrict: incident.COUNCIL_DISTRICT,
        village: incident.VILLAGE,
      },
    });
  }

  /**
   * Map category to risk level.
   */
  private mapCategoryToRisk(type: string, category: string): { category: AlertCategory; risk: RiskLevel } {
    // Check specific category mapping
    const upperCategory = category?.toUpperCase() ?? '';
    if (CATEGORY_MAP[upperCategory]) {
      return CATEGORY_MAP[upperCategory];
    }

    // Default by type
    if (type === 'FIRE') {
      return { category: 'fire', risk: 'high' };
    }
    if (type === 'EMS') {
      // ALS is higher priority than BLS
      if (category === 'ALS') {
        return { category: 'medical', risk: 'high' };
      }
      return { category: 'medical', risk: 'moderate' };
    }

    return { category: 'fire', risk: 'low' };
  }

  /**
   * Build incident title.
   */
  private buildTitle(type: string, category: string): string {
    const categoryLabels: Record<string, string> = {
      ALS: 'Medical Emergency (ALS)',
      BLS: 'Medical Call (BLS)',
      CEMS: 'Community EMS',
      FIRE: 'Fire Incident',
      'MISC SERVICE': 'Service Call',
      SERVICE: 'Service Call',
    };

    if (type === 'FIRE') {
      return category === 'FIRE' ? 'Fire Incident' : `Fire: ${category}`;
    }

    return categoryLabels[category] ?? `${type}: ${category}`;
  }

  /**
   * Build description from incident data.
   */
  private buildDescription(incident: PhoenixFireIncident): string {
    const parts: string[] = [];

    parts.push(`Type: ${incident.TYPE}`);
    parts.push(`Category: ${incident.CATEGORY}`);

    if (incident.CLASSIFICATION) {
      parts.push(`Classification: ${incident.CLASSIFICATION}`);
    }

    if (incident.VILLAGE) {
      parts.push(`Area: ${incident.VILLAGE}`);
    }

    if (incident.STATION?.trim()) {
      parts.push(`Station: ${incident.STATION.trim()}`);
    }

    return parts.join('\n');
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
