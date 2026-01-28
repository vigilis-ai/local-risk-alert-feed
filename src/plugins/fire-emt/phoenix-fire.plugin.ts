import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

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
  REPORTED: number; // Unix timestamp in ms
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
  /** Maximum records to fetch per request. Default: 500 */
  limit?: number;
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
  };

  private fireConfig: PhoenixFirePluginConfig;

  constructor(config?: PhoenixFirePluginConfig) {
    super(config);
    this.fireConfig = {
      includeEMS: true,
      includeService: false,
      limit: 500,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, timeRange, radiusMeters, categories } = options;
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchIncidents(location, timeRange, radiusMeters, categories),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
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
  ) {
    // Phoenix Fire 30-day incident history
    const baseUrl = 'https://maps.phoenix.gov/phxfire/rest/services/IncidentHistory30DayPoints/MapServer/0/query';

    // Build where clause for time range using DATE format (required by this ArcGIS server)
    const startDate = new Date(timeRange.start).toISOString().split('T')[0];
    const endDate = new Date(timeRange.end).toISOString().split('T')[0];

    // Build type filter
    const typeFilters: string[] = ["TYPE='FIRE'"];
    if (this.fireConfig.includeEMS) {
      typeFilters.push("TYPE='EMS'");
    }
    if (this.fireConfig.includeService) {
      typeFilters.push("TYPE='SERVICE'");
    }

    const params = new URLSearchParams({
      where: `REPORTED >= DATE '${startDate}' AND REPORTED <= DATE '${endDate}' AND (${typeFilters.join(' OR ')})`,
      outFields: '*',
      f: 'geojson',
      outSR: '4326',
      resultRecordCount: String(this.fireConfig.limit),
      orderByFields: 'REPORTED DESC',
    });

    const url = `${baseUrl}?${params}`;
    const response = await this.fetchJson<ArcGISGeoJSONResponse>(url);

    if (!response.features) {
      return [];
    }

    // Transform and filter by location
    const alerts = response.features
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

    return alerts;
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

    // Parse timestamp
    const issued = new Date(incident.REPORTED).toISOString();

    // Determine if real-time (within last 24 hours)
    const isRecent = Date.now() - incident.REPORTED < 24 * 60 * 60 * 1000;
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
