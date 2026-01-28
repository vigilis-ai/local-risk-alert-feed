import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Austin real-time fire incident from Socrata API.
 */
interface AustinFireIncident {
  traffic_report_id: string;
  published_date: string;
  issue_reported: string;
  location?: {
    type: string;
    coordinates: [number, number]; // [lng, lat]
  };
  latitude: string;
  longitude: string;
  address: string;
  traffic_report_status: string;
  traffic_report_status_date_time: string;
  agency?: string;
}

/**
 * Austin Fire plugin configuration.
 */
export interface AustinFirePluginConfig extends BasePluginConfig {
  /** Only include active incidents. Default: true */
  activeOnly?: boolean;
  /** Include alarm calls (often false alarms). Default: true */
  includeAlarms?: boolean;
}

/**
 * Austin, TX center coordinates.
 */
const AUSTIN_CENTER = {
  latitude: 30.2672,
  longitude: -97.7431,
};

/**
 * Coverage radius in meters (~40km covers Austin metro).
 */
const COVERAGE_RADIUS_METERS = 40_000;

/**
 * Fire incident type to risk level mapping.
 */
const FIRE_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  // Structure fires
  'FIRE - STRUCTURE': 'severe',
  'FIRE - Structure Fire': 'severe',
  'Structure Fire': 'severe',

  // Vehicle/outdoor fires
  'FIRE - VEHICLE': 'high',
  'FIRE - Vehicle Fire': 'high',
  'FIRE - GRASS': 'high',
  'FIRE - Grass Fire': 'high',
  'Wildland Fire': 'severe',
  'FIRE - DUMPSTER': 'moderate',

  // Alarms
  'ALARM - Fire Alarm': 'low',
  'FIRE ALARM': 'low',
  'Carbon Monoxide Alarm': 'moderate',
  'CO DETECTOR': 'moderate',

  // Hazmat
  'HAZMAT': 'severe',
  'Hazardous Materials': 'severe',
  'Gas Leak': 'high',
  'GAS LEAK': 'high',

  // Rescue
  'RESCUE': 'high',
  'Water Rescue': 'severe',
  'SWIFT WATER': 'severe',
  'Confined Space': 'severe',

  // Other
  'SMOKE INVESTIGATION': 'moderate',
  'Smoke Investigation': 'moderate',
  'ELECTRICAL HAZARD': 'moderate',
};

/**
 * Plugin that fetches real-time fire incidents from Austin, Texas.
 *
 * Uses the City of Austin Open Data Portal Socrata API which updates every 5 minutes.
 * Note: Medical calls are excluded for HIPAA compliance.
 *
 * @see https://data.austintexas.gov/Public-Safety/Real-Time-Fire-Incident-Report-Data/wpu4-x69d
 */
export class AustinFirePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'austin-fire',
    name: 'Austin Fire Department',
    version: '1.0.0',
    description: 'Real-time fire incidents from Austin Fire Department',
    coverage: {
      type: 'regional',
      center: AUSTIN_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Austin, TX metropolitan area',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 5, // Real-time with ~5 minute updates
      freshnessDescription: 'Real-time updates every 5 minutes',
    },
    supportedTemporalTypes: ['real-time'],
    supportedCategories: ['fire'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
  };

  private fireConfig: AustinFirePluginConfig;

  constructor(config?: AustinFirePluginConfig) {
    super(config);
    this.fireConfig = {
      activeOnly: true,
      includeAlarms: true,
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
        () => this.fetchFireIncidents(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Austin Fire fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch fire incidents from Austin Socrata API.
   */
  private async fetchFireIncidents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const baseUrl = 'https://data.austintexas.gov/resource/wpu4-x69d.json';

    // Build SoQL query
    const params = new URLSearchParams({
      $limit: '1000',
      $order: 'published_date DESC',
    });

    // Filter by status if configured
    if (this.fireConfig.activeOnly) {
      params.set('$where', "traffic_report_status='ACTIVE'");
    }

    const url = `${baseUrl}?${params}`;

    try {
      const incidents = await this.fetchJson<AustinFireIncident[]>(url);

      if (!incidents || !Array.isArray(incidents)) {
        return [];
      }

      // Filter by location and time range
      const startTime = new Date(timeRange.start).getTime();
      const endTime = new Date(timeRange.end).getTime();

      const filtered = incidents.filter((incident) => {
        // Must have coordinates
        const lat = parseFloat(incident.latitude);
        const lng = parseFloat(incident.longitude);
        if (isNaN(lat) || isNaN(lng)) return false;

        // Filter by location
        const distance = this.calculateDistance(
          location.latitude,
          location.longitude,
          lat,
          lng
        );
        if (distance > radiusMeters) return false;

        // Filter by time range
        const incidentTime = new Date(incident.published_date).getTime();
        if (incidentTime < startTime || incidentTime > endTime) return false;

        // Filter alarm calls if configured
        if (!this.fireConfig.includeAlarms) {
          const issue = incident.issue_reported.toUpperCase();
          if (issue.includes('ALARM')) {
            return false;
          }
        }

        return true;
      });

      return filtered.map((incident) => this.transformIncident(incident));
    } catch (error) {
      warnings.push(
        `Failed to fetch Austin fire incidents: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Transform an Austin fire incident to our Alert format.
   */
  private transformIncident(incident: AustinFireIncident) {
    const riskLevel = this.mapIssueTypeToRisk(incident.issue_reported);
    const lat = parseFloat(incident.latitude);
    const lng = parseFloat(incident.longitude);

    return this.createAlert({
      id: `austin-fire-${incident.traffic_report_id}`,
      externalId: incident.traffic_report_id,
      title: this.formatIssueType(incident.issue_reported),
      description: this.buildDescription(incident),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'fire',
      temporalType: 'real-time',
      location: {
        point: { latitude: lat, longitude: lng },
        address: incident.address,
        city: 'Austin',
        state: 'TX',
      },
      timestamps: {
        issued: incident.published_date,
        eventStart: incident.published_date,
      },
      metadata: {
        issueReported: incident.issue_reported,
        status: incident.traffic_report_status,
        statusDateTime: incident.traffic_report_status_date_time,
        agency: incident.agency || 'FIRE',
      },
    });
  }

  /**
   * Map issue type to risk level.
   */
  private mapIssueTypeToRisk(issueType: string): RiskLevel {
    // Check exact match
    if (FIRE_TYPE_RISK_MAP[issueType]) {
      return FIRE_TYPE_RISK_MAP[issueType];
    }

    // Check partial matches
    const upperIssue = issueType.toUpperCase();

    if (upperIssue.includes('STRUCTURE')) {
      return 'severe';
    }
    if (upperIssue.includes('WILDLAND') || upperIssue.includes('WILDFIRE')) {
      return 'severe';
    }
    if (upperIssue.includes('HAZMAT') || upperIssue.includes('HAZARDOUS')) {
      return 'severe';
    }
    if (upperIssue.includes('RESCUE') || upperIssue.includes('WATER')) {
      return 'high';
    }
    if (upperIssue.includes('FIRE') && !upperIssue.includes('ALARM')) {
      return 'high';
    }
    if (upperIssue.includes('GAS') || upperIssue.includes('LEAK')) {
      return 'high';
    }
    if (upperIssue.includes('ELECTRICAL')) {
      return 'moderate';
    }
    if (upperIssue.includes('SMOKE')) {
      return 'moderate';
    }
    if (upperIssue.includes('ALARM')) {
      return 'low';
    }

    return 'moderate';
  }

  /**
   * Format issue type for display.
   */
  private formatIssueType(issueType: string): string {
    // Clean up the issue type for display
    return issueType
      .replace(/\s*-\s*/g, ' - ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build description from incident data.
   */
  private buildDescription(incident: AustinFireIncident): string {
    const parts: string[] = [];

    parts.push(`Incident: ${incident.issue_reported}`);
    parts.push(`Location: ${incident.address}`);
    parts.push(`Status: ${incident.traffic_report_status}`);

    if (incident.agency) {
      parts.push(`Agency: ${incident.agency}`);
    }

    parts.push(`Reported: ${new Date(incident.published_date).toLocaleString()}`);

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
