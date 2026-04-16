import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Fire/EMS incident from Phoenix Regional Dispatch ArcGIS service.
 * Phoenix Fire data only contains city codes PHX, PDV (Paradise Valley), LAV (Laveen).
 * Glendale Fire incidents are NOT in this dataset, but Phoenix Fire mutual aid
 * responses in the Glendale area ARE included. We use spatial filtering to capture
 * any fire/EMS incidents near the customer site.
 */
interface PhoenixFireIncident {
  OBJECTID: number;
  INCIDENT: string;
  CITY?: string;
  STATION?: string;
  CATEGORY: string;
  CLASSIFICATION?: string;
  TYPE: string; // FIRE, EMS, SERVICE
  REPORTED: number; // Unix timestamp in ms
  VILLAGE?: string;
  FIRE_DISTRICT?: string;
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
 * Glendale Fire plugin configuration.
 */
export interface GlendaleFirePluginConfig extends BasePluginConfig {
  /** Include EMS calls. Default: true */
  includeEMS?: boolean;
  /** Include service calls (non-emergency). Default: false */
  includeService?: boolean;
  /** Maximum records to fetch per request. Default: 500 */
  limit?: number;
}

/**
 * Glendale, AZ center coordinates (Tanger Outlets area).
 */
const GLENDALE_CENTER = {
  latitude: 33.5340,
  longitude: -112.2340,
};

/**
 * Coverage radius in meters (~20km covers Glendale city area).
 */
const COVERAGE_RADIUS_METERS = 20_000;

/**
 * Category to risk level and alert category mapping.
 */
const CATEGORY_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  // Fire categories
  FIRE: { category: 'fire', risk: 'high' },
  'STRUCTURE FIRE': { category: 'fire', risk: 'extreme' },
  'BRUSH FIRE': { category: 'fire', risk: 'severe' },
  'VEHICLE FIRE': { category: 'fire', risk: 'high' },
  'DUMPSTER FIRE': { category: 'fire', risk: 'moderate' },
  HAZMAT: { category: 'fire', risk: 'severe' },
  'GAS LEAK': { category: 'fire', risk: 'high' },
  'ELECTRICAL FIRE': { category: 'fire', risk: 'high' },

  // EMS categories
  ALS: { category: 'medical', risk: 'high' },
  BLS: { category: 'medical', risk: 'moderate' },
  CEMS: { category: 'medical', risk: 'moderate' },

  // Service categories
  'MISC SERVICE': { category: 'fire', risk: 'low' },
  SERVICE: { category: 'fire', risk: 'low' },
};

/**
 * Plugin that fetches fire and EMS incident data near Glendale, AZ.
 *
 * Uses the Phoenix Fire 30-day incident history with spatial filtering to capture
 * incidents in the Glendale area. Note: this only includes Phoenix Fire Department
 * responses (including mutual aid into Glendale). Glendale Fire Department's own
 * calls are dispatched by CRESA but not published in a public dataset.
 *
 * @see https://maps.phoenix.gov/phxfire/rest/services/IncidentHistory30DayPoints/MapServer
 */
export class GlendaleFirePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'glendale-fire',
    name: 'Glendale Area Fire & EMS',
    version: '1.1.0',
    description: 'Fire and EMS incidents near Glendale, AZ from Phoenix Regional Dispatch',
    coverage: {
      type: 'regional',
      center: GLENDALE_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Glendale, AZ and West Valley area',
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

  private fireConfig: GlendaleFirePluginConfig;

  constructor(config?: GlendaleFirePluginConfig) {
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
      console.error('Glendale Fire fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch incidents from Phoenix Fire ArcGIS service using spatial filtering
   * to get incidents in the Glendale area.
   */
  private async fetchIncidents(
    location: { latitude: number; longitude: number },
    timeRange: { start: string; end: string },
    radiusMeters: number,
    categories?: AlertCategory[]
  ) {
    const baseUrl = 'https://maps.phoenix.gov/phxfire/rest/services/IncidentHistory30DayPoints/MapServer/0/query';

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

    // Use spatial envelope around query location (no CITY filter - Glendale isn't in this dataset)
    const params = new URLSearchParams({
      where: `REPORTED >= DATE '${startDate}' AND REPORTED <= DATE '${endDate}' AND (${typeFilters.join(' OR ')})`,
      outFields: '*',
      f: 'geojson',
      outSR: '4326',
      resultRecordCount: String(this.fireConfig.limit),
      orderByFields: 'REPORTED DESC',
      geometry: `${location.longitude - 0.12},${location.latitude - 0.09},${location.longitude + 0.12},${location.latitude + 0.09}`,
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
    });

    const url = `${baseUrl}?${params}`;
    const response = await this.fetchJson<ArcGISGeoJSONResponse>(url);

    if (!response.features) {
      return [];
    }

    return response.features
      .filter(f => {
        if (!f.geometry?.coordinates) return false;

        const [lng, lat] = f.geometry.coordinates;
        const distance = this.calculateDistance(location.latitude, location.longitude, lat, lng);

        if (distance > radiusMeters) return false;

        if (categories && categories.length > 0) {
          const alertCategory = this.mapTypeToCategory(f.properties.TYPE);
          if (!categories.includes(alertCategory)) return false;
        }

        return true;
      })
      .map(f => this.transformIncident(f.properties, f.geometry.coordinates));
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
   * Transform a fire incident to our Alert format.
   */
  private transformIncident(
    incident: PhoenixFireIncident,
    coordinates: [number, number]
  ) {
    const [longitude, latitude] = coordinates;
    const { category, risk } = this.mapCategoryToRisk(incident.TYPE, incident.CATEGORY);

    const issued = new Date(incident.REPORTED).toISOString();

    const isRecent = Date.now() - incident.REPORTED < 24 * 60 * 60 * 1000;
    const temporalType = isRecent ? 'real-time' : 'historical';

    const title = this.buildTitle(incident.TYPE, incident.CATEGORY);

    return this.createAlert({
      id: `glendale-fire-${incident.INCIDENT}`,
      externalId: incident.INCIDENT,
      title,
      description: this.buildDescription(incident),
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType,
      location: {
        point: { latitude, longitude },
        city: 'Glendale',
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
        city: incident.CITY,
        village: incident.VILLAGE,
        fireDistrict: incident.FIRE_DISTRICT,
      },
    });
  }

  /**
   * Map category to risk level.
   */
  private mapCategoryToRisk(type: string, category: string): { category: AlertCategory; risk: RiskLevel } {
    const upperCategory = category?.toUpperCase() ?? '';
    if (CATEGORY_MAP[upperCategory]) {
      return CATEGORY_MAP[upperCategory];
    }

    if (type === 'FIRE') {
      return { category: 'fire', risk: 'high' };
    }
    if (type === 'EMS') {
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
      'STRUCTURE FIRE': 'Structure Fire',
      'BRUSH FIRE': 'Brush Fire',
      'VEHICLE FIRE': 'Vehicle Fire',
      'MISC SERVICE': 'Service Call',
      SERVICE: 'Service Call',
    };

    if (categoryLabels[category]) {
      return categoryLabels[category];
    }

    if (type === 'FIRE') {
      return category === 'FIRE' ? 'Fire Incident' : `Fire: ${category}`;
    }

    return `${type}: ${category}`;
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

    if (incident.STATION?.trim()) {
      parts.push(`Station: ${incident.STATION.trim()}`);
    }

    if (incident.VILLAGE) {
      parts.push(`Area: ${incident.VILLAGE}`);
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
