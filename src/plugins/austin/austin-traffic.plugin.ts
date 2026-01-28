import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Austin real-time traffic incident from Socrata API.
 */
interface AustinTrafficIncident {
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
 * Austin Traffic plugin configuration.
 */
export interface AustinTrafficPluginConfig extends BasePluginConfig {
  /** Only include active incidents. Default: true */
  activeOnly?: boolean;
  /** Include minor incidents (Traffic Hazard, Stalled Vehicle). Default: true */
  includeMinor?: boolean;
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
 * Issue type to risk level mapping.
 */
const ISSUE_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  // High severity
  'COLLISION': 'high',
  'COLLISION/PRIVATE PROPERTY': 'moderate',
  'Crash Service': 'high',
  'Crash Urgent': 'severe',
  'AUTO/ PED': 'severe',
  'Traffic Fatality': 'extreme',

  // Medium severity
  'Traffic Hazard': 'moderate',
  'BLOCKED DRIV/ HI-WATER': 'high',
  'FLOODING': 'severe',
  'Ice On Road': 'severe',
  'Loose Livestock': 'moderate',
  'TRFC HAZD/ DEBRIS': 'moderate',

  // Lower severity
  'Stalled Vehicle': 'low',
  'BOAT ACCIDENT': 'moderate',
};

/**
 * Plugin that fetches real-time traffic incidents from Austin, Texas.
 *
 * Uses the City of Austin Open Data Portal Socrata API which updates every 5 minutes.
 *
 * @see https://data.austintexas.gov/Transportation-and-Mobility/Real-Time-Traffic-Incident-Reports/dx9v-zd7x
 */
export class AustinTrafficPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'austin-traffic',
    name: 'Austin Traffic',
    version: '1.0.0',
    description: 'Real-time traffic incidents from Austin, Texas',
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
    supportedCategories: ['traffic'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
    defaultRadiusMeters: 10_000,
  };

  private trafficConfig: AustinTrafficPluginConfig;

  constructor(config?: AustinTrafficPluginConfig) {
    super(config);
    this.trafficConfig = {
      activeOnly: true,
      includeMinor: true,
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
        () => this.fetchTrafficIncidents(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Austin Traffic fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch traffic incidents from Austin Socrata API.
   */
  private async fetchTrafficIncidents(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const baseUrl = 'https://data.austintexas.gov/resource/dx9v-zd7x.json';

    // Build SoQL query
    const params = new URLSearchParams({
      $limit: '1000',
      $order: 'published_date DESC',
    });

    // Filter by status if configured
    if (this.trafficConfig.activeOnly) {
      params.set('$where', "traffic_report_status='ACTIVE'");
    }

    const url = `${baseUrl}?${params}`;

    try {
      const incidents = await this.fetchJson<AustinTrafficIncident[]>(url);

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

        // Filter minor incidents if configured
        if (!this.trafficConfig.includeMinor) {
          const issue = incident.issue_reported.toUpperCase();
          if (issue.includes('STALLED') || issue.includes('HAZARD')) {
            return false;
          }
        }

        return true;
      });

      return filtered.map((incident) => this.transformIncident(incident));
    } catch (error) {
      warnings.push(
        `Failed to fetch Austin traffic incidents: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Transform an Austin traffic incident to our Alert format.
   */
  private transformIncident(incident: AustinTrafficIncident) {
    const riskLevel = this.mapIssueTypeToRisk(incident.issue_reported);
    const lat = parseFloat(incident.latitude);
    const lng = parseFloat(incident.longitude);

    return this.createAlert({
      id: `austin-traffic-${incident.traffic_report_id}`,
      externalId: incident.traffic_report_id,
      title: this.formatIssueType(incident.issue_reported),
      description: this.buildDescription(incident),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'traffic',
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
        agency: incident.agency,
      },
    });
  }

  /**
   * Map issue type to risk level.
   */
  private mapIssueTypeToRisk(issueType: string): RiskLevel {
    // Check exact match
    if (ISSUE_TYPE_RISK_MAP[issueType]) {
      return ISSUE_TYPE_RISK_MAP[issueType];
    }

    // Check partial matches
    const upperIssue = issueType.toUpperCase();

    if (upperIssue.includes('FATALITY') || upperIssue.includes('FATAL')) {
      return 'extreme';
    }
    if (upperIssue.includes('PEDESTRIAN') || upperIssue.includes('AUTO/ PED')) {
      return 'severe';
    }
    if (upperIssue.includes('FLOOD') || upperIssue.includes('ICE')) {
      return 'severe';
    }
    if (upperIssue.includes('COLLISION') || upperIssue.includes('CRASH')) {
      return 'high';
    }
    if (upperIssue.includes('HAZARD') || upperIssue.includes('DEBRIS')) {
      return 'moderate';
    }
    if (upperIssue.includes('STALLED') || upperIssue.includes('DISABLED')) {
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
      .replace(/\//g, ' / ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .split(' ')
      .map((word) => {
        if (word.length <= 2) return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ')
      .trim();
  }

  /**
   * Build description from incident data.
   */
  private buildDescription(incident: AustinTrafficIncident): string {
    const parts: string[] = [];

    parts.push(`Issue: ${incident.issue_reported}`);
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
