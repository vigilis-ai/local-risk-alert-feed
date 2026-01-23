import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Phoenix Police incident response from Socrata API.
 */
interface PhoenixPoliceIncident {
  inc_number: string;
  ucr_crime_category: string;
  hundredblockaddr: string;
  grid: string;
  premise_type?: string;
  disposition?: string;
  occurred_on?: string;
  occurred_to?: string;
  reported_on?: string;
  latitude?: string;
  longitude?: string;
}

/**
 * Phoenix Police plugin configuration.
 */
export interface PhoenixPolicePluginConfig extends BasePluginConfig {
  /** Socrata app token for higher rate limits (optional) */
  appToken?: string;
  /** Maximum records to fetch per request. Default: 1000 */
  limit?: number;
}

/**
 * Phoenix Police crime center coordinates.
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
 * Crime categories and their risk mappings.
 */
const CRIME_RISK_MAP: Record<string, RiskLevel> = {
  HOMICIDE: 'extreme',
  'AGGRAVATED ASSAULT': 'severe',
  ROBBERY: 'severe',
  'SEXUAL ASSAULT': 'severe',
  ARSON: 'high',
  BURGLARY: 'high',
  'MOTOR VEHICLE THEFT': 'moderate',
  THEFT: 'moderate',
  'DRUG OFFENSE': 'moderate',
  LARCENY: 'low',
  MISCELLANEOUS: 'low',
};

/**
 * Plugin that fetches crime data from the Phoenix Open Data Portal.
 *
 * Uses the Phoenix Crime Incidents dataset via Socrata API.
 *
 * @see https://www.phoenixopendata.com/dataset/crime-data
 */
export class PhoenixPolicePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'phoenix-police',
    name: 'Phoenix Police Department',
    version: '1.0.0',
    description: 'Crime incidents from Phoenix Police Department',
    coverage: {
      type: 'regional',
      center: PHOENIX_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Phoenix, AZ metropolitan area',
    },
    supportedTemporalTypes: ['historical'],
    supportedCategories: ['crime'],
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
  };

  private phoenixConfig: PhoenixPolicePluginConfig;

  constructor(config?: PhoenixPolicePluginConfig) {
    super(config);
    this.phoenixConfig = {
      limit: 1000,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const cacheKey = this.generateCacheKey(options);

    // NOTE: Phoenix Open Data no longer provides a Socrata API for crime data.
    // The data is only available as CSV downloads, which is not suitable for real-time querying.
    // This plugin is kept for backwards compatibility but returns empty results.
    // See: https://www.phoenixopendata.com/dataset/crime-data
    const warnings = [
      'Phoenix Police data source unavailable: Phoenix Open Data has discontinued the Socrata API. ' +
      'Crime data is now only available as CSV downloads, which cannot be queried in real-time.'
    ];

    return {
      alerts: [],
      fromCache: false,
      cacheKey,
      warnings,
    };
  }

  /**
   * Build the Socrata API URL for Phoenix crime data.
   */
  private buildApiUrl(
    location: { latitude: number; longitude: number },
    timeRange: { start: string; end: string },
    radiusMeters: number,
    limit?: number
  ): string {
    const baseUrl = 'https://www.phoenixopendata.com/resource/b4ez-nd22.json';

    // Build SoQL query
    const params = new URLSearchParams();

    // Limit results
    params.set('$limit', String(limit ?? this.phoenixConfig.limit));

    // Order by most recent
    params.set('$order', 'occurred_on DESC');

    // Build WHERE clause for time range and location
    const whereClauses: string[] = [];

    // Time filter using occurred_on field
    const startDate = timeRange.start.split('T')[0];
    const endDate = timeRange.end.split('T')[0];
    whereClauses.push(`occurred_on >= '${startDate}'`);
    whereClauses.push(`occurred_on <= '${endDate}'`);

    // Location filter using within_circle function (Socrata specific)
    // Convert radius from meters to meters (Socrata uses meters)
    whereClauses.push(
      `within_circle(location_1, ${location.latitude}, ${location.longitude}, ${radiusMeters})`
    );

    params.set('$where', whereClauses.join(' AND '));

    // Add app token if provided (for higher rate limits)
    if (this.phoenixConfig.appToken) {
      params.set('$$app_token', this.phoenixConfig.appToken);
    }

    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Fetch incidents from the API.
   */
  private async fetchIncidents(url: string): Promise<PhoenixPoliceIncident[]> {
    return this.fetchJson<PhoenixPoliceIncident[]>(url);
  }

  /**
   * Transform a Phoenix Police incident to our Alert format.
   */
  private transformIncident(incident: PhoenixPoliceIncident) {
    const category = incident.ucr_crime_category?.toUpperCase() ?? 'MISCELLANEOUS';
    const riskLevel = this.mapCrimeToRiskLevel(category);

    // Parse coordinates
    const latitude = incident.latitude ? parseFloat(incident.latitude) : PHOENIX_CENTER.latitude;
    const longitude = incident.longitude
      ? parseFloat(incident.longitude)
      : PHOENIX_CENTER.longitude;

    // Determine time - use occurred_on or reported_on
    const occurredOn = incident.occurred_on ?? incident.reported_on ?? new Date().toISOString();
    const occurredTo = incident.occurred_to;

    return this.createAlert({
      id: `phoenix-police-${incident.inc_number}`,
      externalId: incident.inc_number,
      title: this.formatCrimeTitle(category),
      description: this.buildDescription(incident),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'crime',
      temporalType: 'historical',
      location: {
        point: { latitude, longitude },
        address: incident.hundredblockaddr,
        city: 'Phoenix',
        state: 'AZ',
      },
      timestamps: {
        issued: occurredOn,
        eventStart: occurredOn,
        eventEnd: occurredTo,
      },
      metadata: {
        incidentNumber: incident.inc_number,
        crimeCategory: category,
        grid: incident.grid,
        premiseType: incident.premise_type,
        disposition: incident.disposition,
      },
    });
  }

  /**
   * Map a crime category to a risk level.
   */
  private mapCrimeToRiskLevel(category: string): RiskLevel {
    return CRIME_RISK_MAP[category] ?? 'moderate';
  }

  /**
   * Format the crime category as a title.
   */
  private formatCrimeTitle(category: string): string {
    // Convert "AGGRAVATED ASSAULT" to "Aggravated Assault"
    return category
      .toLowerCase()
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Build a description from incident data.
   */
  private buildDescription(incident: PhoenixPoliceIncident): string {
    const parts: string[] = [];

    if (incident.ucr_crime_category) {
      parts.push(`Crime Type: ${this.formatCrimeTitle(incident.ucr_crime_category)}`);
    }

    if (incident.hundredblockaddr) {
      parts.push(`Location: ${incident.hundredblockaddr}`);
    }

    if (incident.premise_type) {
      parts.push(`Premise: ${incident.premise_type}`);
    }

    if (incident.disposition) {
      parts.push(`Status: ${incident.disposition}`);
    }

    return parts.join('\n');
  }
}
