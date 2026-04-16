import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Glendale Police call for service from the GPD ArcGIS spatial layer.
 *
 * @see https://services1.arcgis.com/9fVTQQSiODPjLUTa/ArcGIS/rest/services/P1_CFS_REDACTED_PT_hosted/FeatureServer/47
 */
interface GlendalePoliceCall {
  OBJECTID: number;
  IncidentNumber: string;
  IncidentDate: number; // Unix timestamp in ms
  IncidentTypeDescription: string;
  InitialIncidentTypeDescription?: string;
  IncidentTypeCode?: string;
  CallSource?: string;
  CurrentPriorityKey?: number;
  Location?: string;
  CityName?: string;
  ZipCode?: string;
  BeatName?: string;
  AreaName?: string;
  SectorName?: string;
  Latitude?: number;
  Longitude?: number;
  AllDispositionDescriptions?: string;
  Council_District_GIS?: string;
  PATROL_DIVISION_GIS?: string;
}

/**
 * ArcGIS GeoJSON response.
 */
interface ArcGISGeoJSONResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: GlendalePoliceCall;
    geometry: {
      type: 'Point';
      coordinates: [number, number]; // [lng, lat]
    };
  }>;
}

/**
 * Glendale Police plugin configuration.
 */
export interface GlendalePolicePluginConfig extends BasePluginConfig {
  /** Maximum records to fetch per request. Default: 500 */
  limit?: number;
  /** Include low-priority calls (noise, parking). Default: true */
  includeLowPriority?: boolean;
}

/**
 * Glendale, AZ center coordinates (Tanger Outlets area).
 */
const GLENDALE_CENTER = {
  latitude: 33.5340,
  longitude: -112.2340,
};

/**
 * Coverage radius in meters (~20km covers Glendale city limits).
 */
const COVERAGE_RADIUS_METERS = 20_000;

/**
 * Incident type description to risk level and category mapping.
 * Based on actual Glendale PD IncidentTypeDescription values.
 */
const CALL_TYPE_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  // Violent crimes - severe/extreme
  'ASSAULT': { category: 'crime', risk: 'severe' },
  'AGGRAVATED ASSAULT': { category: 'crime', risk: 'extreme' },
  'ROBBERY': { category: 'crime', risk: 'severe' },
  'ARMED ROBBERY': { category: 'crime', risk: 'extreme' },
  'SHOOTING': { category: 'crime', risk: 'extreme' },
  'SHOTS FIRED': { category: 'crime', risk: 'extreme' },
  'STABBING': { category: 'crime', risk: 'extreme' },
  'HOMICIDE': { category: 'crime', risk: 'extreme' },
  'KIDNAPPING': { category: 'crime', risk: 'extreme' },
  'WEAPONS OFFENSE': { category: 'crime', risk: 'severe' },
  'DOMESTIC VIOLENCE': { category: 'crime', risk: 'severe' },

  // Property crimes - high/moderate
  'BURGLARY': { category: 'crime', risk: 'high' },
  'RESIDENTIAL BURGLARY': { category: 'crime', risk: 'high' },
  'COMMERCIAL BURGLARY': { category: 'crime', risk: 'high' },
  'VEHICLE THEFT': { category: 'crime', risk: 'high' },
  'THEFT': { category: 'crime', risk: 'moderate' },
  'SHOPLIFTING': { category: 'crime', risk: 'low' },
  'VANDALISM': { category: 'crime', risk: 'moderate' },
  'CRIMINAL DAMAGE': { category: 'crime', risk: 'moderate' },
  'TRESPASSING': { category: 'crime', risk: 'moderate' },

  // Suspicious activity
  'SUSPICIOUS PERSON': { category: 'crime', risk: 'moderate' },
  'SUSPICIOUS VEHICLE': { category: 'crime', risk: 'moderate' },
  'SUSPICIOUS ACTIVITY': { category: 'crime', risk: 'moderate' },
  'PROWLER': { category: 'crime', risk: 'high' },

  // Traffic related
  'DUI': { category: 'traffic', risk: 'high' },
  'HIT AND RUN': { category: 'traffic', risk: 'high' },
  'TRAFFIC ACCIDENT': { category: 'traffic', risk: 'moderate' },
  'ACCIDENT WITH INJURIES': { category: 'traffic', risk: 'high' },
  'RECKLESS DRIVING': { category: 'traffic', risk: 'moderate' },

  // Disorder
  'DISTURBANCE': { category: 'crime', risk: 'moderate' },
  'FIGHT': { category: 'crime', risk: 'high' },
  'DISORDERLY CONDUCT': { category: 'crime', risk: 'moderate' },

  // Low priority
  'ALARM': { category: 'crime', risk: 'low' },
  'NOISE COMPLAINT': { category: 'other', risk: 'low' },
  'PARKING VIOLATION': { category: 'traffic', risk: 'low' },
  'CIVIL MATTER': { category: 'other', risk: 'low' },
  'WELFARE CHECK': { category: 'other', risk: 'moderate' },
  'FOUND PROPERTY': { category: 'other', risk: 'low' },
  'LOST PROPERTY': { category: 'other', risk: 'low' },
};

/**
 * Low priority call types that can be filtered out.
 */
const LOW_PRIORITY_TYPES = new Set([
  'ALARM',
  'NOISE COMPLAINT',
  'PARKING VIOLATION',
  'CIVIL MATTER',
  'FOUND PROPERTY',
  'LOST PROPERTY',
  'INFORMATION',
  'ABANDONED VEHICLE',
]);

/**
 * Plugin that fetches police calls for service from Glendale, AZ Police Department.
 *
 * Uses the Glendale PD public spatial calls-for-service layer (332K+ records, updated daily).
 * ArcGIS org: 9fVTQQSiODPjLUTa, Layer 47.
 *
 * @see https://services1.arcgis.com/9fVTQQSiODPjLUTa/ArcGIS/rest/services/P1_CFS_REDACTED_PT_hosted/FeatureServer/47
 */
export class GlendalePolicePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'glendale-police',
    name: 'Glendale Police Department',
    version: '1.1.0',
    description: 'Police calls for service from Glendale, AZ Police Department',
    coverage: {
      type: 'regional',
      center: GLENDALE_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Glendale, AZ and surrounding West Valley area',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 1440, // ~24 hour delay
      freshnessDescription: '~24 hour delay',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['crime', 'traffic', 'other'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
    defaultRadiusMeters: 10_000,
  };

  private policeConfig: GlendalePolicePluginConfig;

  constructor(config?: GlendalePolicePluginConfig) {
    super(config);
    this.policeConfig = {
      limit: 500,
      includeLowPriority: true,
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
        () => this.fetchCalls(location, timeRange, radiusMeters, categories),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Glendale Police fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch calls for service from Glendale PD ArcGIS spatial layer.
   */
  private async fetchCalls(
    location: { latitude: number; longitude: number },
    timeRange: { start: string; end: string },
    radiusMeters: number,
    categories?: AlertCategory[]
  ) {
    // Glendale PD public calls for service - spatial layer with point geometry
    const baseUrl = 'https://services1.arcgis.com/9fVTQQSiODPjLUTa/ArcGIS/rest/services/P1_CFS_REDACTED_PT_hosted/FeatureServer/47/query';

    const startDate = new Date(timeRange.start).toISOString().split('T')[0];
    const endDate = new Date(timeRange.end).toISOString().split('T')[0];

    const params = new URLSearchParams({
      where: `IncidentDate >= DATE '${startDate}' AND IncidentDate <= DATE '${endDate}'`,
      outFields: '*',
      f: 'geojson',
      outSR: '4326',
      resultRecordCount: String(this.policeConfig.limit),
      orderByFields: 'IncidentDate DESC',
      // Spatial filter: bounding box around query location
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

        // Filter low priority if configured
        if (!this.policeConfig.includeLowPriority) {
          const callType = (f.properties.IncidentTypeDescription ?? '').toUpperCase();
          if (LOW_PRIORITY_TYPES.has(callType)) return false;
        }

        // Filter by categories if specified
        if (categories && categories.length > 0) {
          const callType = (f.properties.IncidentTypeDescription ?? '').toUpperCase();
          const alertCategory = this.mapCallTypeToCategory(callType);
          if (!categories.includes(alertCategory)) return false;
        }

        return true;
      })
      .map(f => this.transformCall(f.properties, f.geometry.coordinates));
  }

  /**
   * Map call type to alert category.
   */
  private mapCallTypeToCategory(callType: string): AlertCategory {
    const mapping = CALL_TYPE_MAP[callType];
    if (mapping) return mapping.category;

    const lowerType = callType.toLowerCase();
    if (lowerType.includes('traffic') || lowerType.includes('accident') || lowerType.includes('dui')) {
      return 'traffic';
    }
    if (lowerType.includes('fire') || lowerType.includes('medic')) {
      return 'fire';
    }
    return 'crime';
  }

  /**
   * Transform a Glendale PD call to our Alert format.
   */
  private transformCall(
    call: GlendalePoliceCall,
    coordinates: [number, number]
  ) {
    const [longitude, latitude] = coordinates;
    const callType = (call.IncidentTypeDescription ?? 'UNKNOWN').toUpperCase();
    const { category, risk } = this.mapCallTypeToRisk(callType);

    const issued = new Date(call.IncidentDate).toISOString();

    const isRecent = Date.now() - call.IncidentDate < 24 * 60 * 60 * 1000;
    const temporalType = isRecent ? 'real-time' : 'historical';

    return this.createAlert({
      id: `glendale-police-${call.IncidentNumber}`,
      externalId: call.IncidentNumber,
      title: this.formatCallType(call.IncidentTypeDescription ?? callType),
      description: this.buildDescription(call),
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType,
      location: {
        point: { latitude, longitude },
        address: call.Location,
        city: call.CityName ?? 'Glendale',
        state: 'AZ',
        zipCode: call.ZipCode,
      },
      timestamps: {
        issued,
        eventStart: issued,
      },
      metadata: {
        incidentNumber: call.IncidentNumber,
        callType: call.IncidentTypeDescription,
        initialCallType: call.InitialIncidentTypeDescription,
        priority: call.CurrentPriorityKey,
        callSource: call.CallSource,
        beat: call.BeatName,
        area: call.AreaName,
        sector: call.SectorName,
        disposition: call.AllDispositionDescriptions,
        patrolDivision: call.PATROL_DIVISION_GIS,
      },
    });
  }

  /**
   * Map call type to risk level.
   */
  private mapCallTypeToRisk(callType: string): { category: AlertCategory; risk: RiskLevel } {
    const mapping = CALL_TYPE_MAP[callType];
    if (mapping) return mapping;

    const lowerType = callType.toLowerCase();

    if (lowerType.includes('shooting') || lowerType.includes('homicide') || lowerType.includes('stabbing')) {
      return { category: 'crime', risk: 'extreme' };
    }
    if (lowerType.includes('assault') || lowerType.includes('robbery') || lowerType.includes('weapon')) {
      return { category: 'crime', risk: 'severe' };
    }
    if (lowerType.includes('burglary') || lowerType.includes('theft') || lowerType.includes('dui')) {
      return { category: 'crime', risk: 'high' };
    }
    if (lowerType.includes('suspicious') || lowerType.includes('disturbance') || lowerType.includes('dispute')) {
      return { category: 'crime', risk: 'moderate' };
    }
    if (lowerType.includes('accident') || lowerType.includes('traffic')) {
      return { category: 'traffic', risk: 'moderate' };
    }

    return { category: 'crime', risk: 'low' };
  }

  /**
   * Format call type for display.
   */
  private formatCallType(callType: string): string {
    return callType
      .split(/[\s_]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
      .trim();
  }

  /**
   * Build description from call data.
   */
  private buildDescription(call: GlendalePoliceCall): string {
    const parts: string[] = [];

    parts.push(`Type: ${call.IncidentTypeDescription}`);

    if (call.InitialIncidentTypeDescription && call.InitialIncidentTypeDescription !== call.IncidentTypeDescription) {
      parts.push(`Initial Type: ${call.InitialIncidentTypeDescription}`);
    }

    if (call.Location) {
      parts.push(`Location: ${call.Location}`);
    }

    if (call.CurrentPriorityKey) {
      parts.push(`Priority: ${call.CurrentPriorityKey}`);
    }

    if (call.BeatName) {
      parts.push(`Beat: ${call.BeatName}`);
    }

    if (call.AllDispositionDescriptions) {
      parts.push(`Disposition: ${call.AllDispositionDescriptions}`);
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
