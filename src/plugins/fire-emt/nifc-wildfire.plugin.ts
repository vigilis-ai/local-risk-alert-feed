import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * NIFC wildfire incident structure.
 */
interface NIFCWildfireIncident {
  OBJECTID: number;
  IncidentName: string;
  IncidentTypeCategory: string; // 'WF' = wildfire, 'RX' = prescribed burn
  POOState: string; // e.g., 'US-AZ'
  POOCounty?: string;
  DailyAcres?: number;
  CalculatedAcres?: number;
  PercentContained?: number;
  FireDiscoveryDateTime?: number; // Unix timestamp in ms
  ModifiedOnDateTime?: number;
  InitialLatitude?: number;
  InitialLongitude?: number;
  FireCause?: string;
  FireBehaviorGeneral?: string;
  IsActive?: string;
  IncidentManagementOrganization?: string;
  POOCity?: string;
}

/**
 * NIFC ArcGIS response structure.
 */
interface NIFCArcGISResponse {
  features: Array<{
    attributes: NIFCWildfireIncident;
    geometry?: {
      x: number;
      y: number;
    };
  }>;
}

/**
 * NIFC Wildfire plugin configuration.
 */
export interface NIFCWildfirePluginConfig extends BasePluginConfig {
  /** Include prescribed burns (RX). Default: false */
  includePrescribedBurns?: boolean;
  /** Minimum fire size in acres to include. Default: 0 */
  minAcres?: number;
  /** Only include fires in these states (2-letter codes). Default: all */
  states?: string[];
}

/**
 * US center coordinates for national coverage.
 */
const US_CENTER = {
  latitude: 39.8283,
  longitude: -98.5795,
};

/**
 * Full US coverage radius.
 */
const US_COVERAGE_RADIUS_METERS = 3_000_000;

/**
 * Fire size to risk level mapping.
 */
function getFireRiskLevel(acres: number | undefined, percentContained: number | undefined): RiskLevel {
  const containment = percentContained ?? 0;
  const size = acres ?? 0;

  // Fully contained fires are lower risk
  if (containment >= 100) {
    return 'low';
  }

  // Large uncontained fires are extreme risk
  if (size >= 10000 && containment < 50) {
    return 'extreme';
  }

  if (size >= 5000 && containment < 75) {
    return 'severe';
  }

  if (size >= 1000) {
    return 'high';
  }

  if (size >= 100) {
    return 'moderate';
  }

  return 'low';
}

/**
 * Plugin that fetches active wildfire data from NIFC (National Interagency Fire Center).
 *
 * Uses the WFIGS (Wildland Fire Interagency Geospatial Services) public ArcGIS endpoint.
 *
 * @see https://data-nifc.opendata.arcgis.com/
 */
export class NIFCWildfirePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'nifc-wildfire',
    name: 'NIFC Wildfires',
    version: '1.0.0',
    description: 'Active wildfire incidents from National Interagency Fire Center',
    coverage: {
      type: 'global',
      center: US_CENTER,
      radiusMeters: US_COVERAGE_RADIUS_METERS,
      description: 'United States wildfire incidents',
    },
    supportedTemporalTypes: ['real-time'],
    supportedCategories: ['fire'],
    refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
  };

  private pluginConfig: NIFCWildfirePluginConfig;

  constructor(config?: NIFCWildfirePluginConfig) {
    super(config);
    this.pluginConfig = {
      includePrescribedBurns: false,
      minAcres: 0,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters } = options;
    const cacheKey = this.generateCacheKey(options);

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchWildfires(location, radiusMeters),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
      };
    } catch (error) {
      console.error('NIFC Wildfire fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch wildfires from NIFC WFIGS service.
   */
  private async fetchWildfires(
    location: { latitude: number; longitude: number },
    radiusMeters: number
  ) {
    // NIFC WFIGS Current Incident Locations
    const baseUrl = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';

    // Build where clause
    const whereClauses: string[] = ['1=1'];

    // Filter by incident type
    if (!this.pluginConfig.includePrescribedBurns) {
      whereClauses.push("IncidentTypeCategory='WF'");
    }

    // Filter by minimum acres
    if (this.pluginConfig.minAcres && this.pluginConfig.minAcres > 0) {
      whereClauses.push(`DailyAcres>=${this.pluginConfig.minAcres}`);
    }

    // Filter by states
    if (this.pluginConfig.states && this.pluginConfig.states.length > 0) {
      const stateList = this.pluginConfig.states.map(s => `'US-${s}'`).join(',');
      whereClauses.push(`POOState IN (${stateList})`);
    }

    const params = new URLSearchParams({
      where: whereClauses.join(' AND '),
      outFields: '*',
      f: 'json',
      resultRecordCount: '500',
    });

    const url = `${baseUrl}?${params}`;
    const response = await this.fetchJson<NIFCArcGISResponse>(url);

    if (!response.features) {
      return [];
    }

    // Transform and filter by location
    const alerts = response.features
      .filter(f => {
        const lat = f.attributes.InitialLatitude ?? f.geometry?.y;
        const lng = f.attributes.InitialLongitude ?? f.geometry?.x;

        if (!lat || !lng) return false;

        const distance = this.calculateDistance(
          location.latitude,
          location.longitude,
          lat,
          lng
        );
        return distance <= radiusMeters;
      })
      .map(f => this.transformIncident(f.attributes, f.geometry));

    return alerts;
  }

  /**
   * Transform a NIFC incident to our Alert format.
   */
  private transformIncident(
    incident: NIFCWildfireIncident,
    geometry?: { x: number; y: number }
  ) {
    const latitude = incident.InitialLatitude ?? geometry?.y ?? 0;
    const longitude = incident.InitialLongitude ?? geometry?.x ?? 0;
    const acres = incident.DailyAcres ?? incident.CalculatedAcres;
    const riskLevel = getFireRiskLevel(acres, incident.PercentContained);

    // Parse state from POOState (e.g., 'US-AZ' -> 'AZ')
    const state = incident.POOState?.replace('US-', '') ?? '';

    // Format discovery time
    const discoveryTime = incident.FireDiscoveryDateTime
      ? new Date(incident.FireDiscoveryDateTime).toISOString()
      : undefined;

    const modifiedTime = incident.ModifiedOnDateTime
      ? new Date(incident.ModifiedOnDateTime).toISOString()
      : new Date().toISOString();

    return this.createAlert({
      id: `nifc-${incident.OBJECTID}`,
      externalId: String(incident.OBJECTID),
      title: incident.IncidentName || 'Unnamed Fire',
      description: this.buildDescription(incident, acres),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'fire',
      temporalType: 'real-time',
      location: {
        point: { latitude, longitude },
        city: incident.POOCity,
        state,
      },
      timestamps: {
        issued: modifiedTime,
        eventStart: discoveryTime,
      },
      metadata: {
        incidentType: incident.IncidentTypeCategory === 'WF' ? 'Wildfire' : 'Prescribed Burn',
        acres,
        percentContained: incident.PercentContained,
        fireCause: incident.FireCause,
        fireBehavior: incident.FireBehaviorGeneral,
        managementOrg: incident.IncidentManagementOrganization,
        county: incident.POOCounty,
      },
    });
  }

  /**
   * Build description from incident data.
   */
  private buildDescription(incident: NIFCWildfireIncident, acres?: number): string {
    const parts: string[] = [];

    const type = incident.IncidentTypeCategory === 'WF' ? 'Wildfire' : 'Prescribed Burn';
    parts.push(`Type: ${type}`);

    if (acres) {
      parts.push(`Size: ${acres.toLocaleString()} acres`);
    }

    if (incident.PercentContained !== undefined && incident.PercentContained !== null) {
      parts.push(`Containment: ${incident.PercentContained}%`);
    }

    if (incident.FireCause) {
      parts.push(`Cause: ${incident.FireCause}`);
    }

    if (incident.FireBehaviorGeneral) {
      parts.push(`Behavior: ${incident.FireBehaviorGeneral}`);
    }

    if (incident.POOCounty) {
      parts.push(`County: ${incident.POOCounty}`);
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
