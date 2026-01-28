import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Austin crime report from Socrata API.
 */
interface AustinCrimeReport {
  incident_report_number: string;
  crime_type: string;
  ucr_code?: string;
  family_violence: string;
  occ_date_time: string;
  occ_date: string;
  rep_date: string;
  location_type?: string;
  address?: string;
  council_district?: string;
  sector?: string;
  district?: string;
  clearance_status?: string;
  census_block_group?: string;
  latitude?: string;
  longitude?: string;
}

/**
 * Austin Crime plugin configuration.
 */
export interface AustinCrimePluginConfig extends BasePluginConfig {
  /** Include family violence incidents. Default: true */
  includeFamilyViolence?: boolean;
  /** Minimum risk level to include (filters out low-level offenses). Default: undefined (all) */
  minRiskLevel?: RiskLevel;
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
 * Austin council district approximate centroids.
 * Used to assign approximate coordinates to crime reports.
 */
const DISTRICT_CENTROIDS: Record<string, { latitude: number; longitude: number }> = {
  '1': { latitude: 30.3847, longitude: -97.6892 },
  '2': { latitude: 30.1858, longitude: -97.7692 },
  '3': { latitude: 30.2321, longitude: -97.7123 },
  '4': { latitude: 30.2456, longitude: -97.7789 },
  '5': { latitude: 30.2012, longitude: -97.8234 },
  '6': { latitude: 30.3945, longitude: -97.7234 },
  '7': { latitude: 30.3456, longitude: -97.7567 },
  '8': { latitude: 30.2134, longitude: -97.8567 },
  '9': { latitude: 30.2867, longitude: -97.7234 },
  '10': { latitude: 30.3234, longitude: -97.8123 },
};

/**
 * Crime type to risk level mapping.
 */
const CRIME_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  // Violent crimes
  'MURDER': 'extreme',
  'HOMICIDE': 'extreme',
  'AGG ASSAULT': 'severe',
  'AGGRAVATED ASSAULT': 'severe',
  'ROBBERY': 'severe',
  'ROBBERY BY ASSAULT': 'severe',
  'ROBBERY BY THREAT': 'severe',
  'SEXUAL ASSAULT': 'severe',
  'KIDNAPPING': 'severe',

  // High severity
  'ASSAULT W/INJURY': 'high',
  'ASSAULT WITH INJURY': 'high',
  'ASSAULT': 'high',
  'BURGLARY': 'high',
  'BURGLARY OF RESIDENCE': 'high',
  'BURGLARY OF VEHICLE': 'moderate',
  'BURGLARY NON RESIDENCE': 'high',
  'AUTO THEFT': 'high',
  'THEFT OF MOTOR VEHICLE': 'high',
  'ARSON': 'severe',

  // Medium severity
  'THEFT': 'moderate',
  'THEFT FROM AUTO': 'moderate',
  'THEFT OF PROPERTY': 'moderate',
  'SHOPLIFTING': 'low',
  'CRIMINAL MISCHIEF': 'moderate',
  'VANDALISM': 'moderate',

  // Lower severity
  'DISTURBANCE': 'low',
  'DISTURBANCE - OTHER': 'low',
  'TRESPASS': 'low',
  'PUBLIC INTOXICATION': 'low',
  'HARASSMENT': 'moderate',
  'DISORDERLY CONDUCT': 'low',

  // Drug related
  'POSS CONTROLLED SUBSTANCE': 'moderate',
  'POSSESSION OF MARIJUANA': 'low',
  'DRUG OFFENSE': 'moderate',

  // Weapons
  'UNLAWFUL CARRYING WEAPON': 'high',
  'WEAPONS OFFENSE': 'high',

  // Traffic
  'DWI': 'high',
  'DUI': 'high',
  'DRIVING WHILE INTOXICATED': 'high',
};

/**
 * Plugin that fetches crime reports from Austin Police Department.
 *
 * Uses the City of Austin Open Data Portal Socrata API.
 * Data is updated daily with recent crime reports.
 *
 * NOTE: APD crime data does not include precise coordinates for privacy
 * protection. This plugin returns city-wide data when the query location
 * is within Austin bounds. Alerts are assigned approximate coordinates
 * based on council district centroids.
 *
 * @see https://data.austintexas.gov/Public-Safety/Crime-Reports/fdj4-gpfu
 */
export class AustinCrimePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'austin-crime',
    name: 'Austin Police Department Crime Reports',
    version: '1.0.0',
    description: 'Crime reports from Austin Police Department',
    coverage: {
      type: 'regional',
      center: AUSTIN_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Austin, TX metropolitan area',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 1440, // ~24 hour delay for crime reports
      freshnessDescription: '~24 hour delay',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['crime'],
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
    defaultRadiusMeters: 10_000,
  };

  private crimeConfig: AustinCrimePluginConfig;

  constructor(config?: AustinCrimePluginConfig) {
    super(config);
    this.crimeConfig = {
      includeFamilyViolence: true,
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
        () => this.fetchCrimeReports(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Austin Crime fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch crime reports from Austin Socrata API.
   */
  private async fetchCrimeReports(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const baseUrl = 'https://data.austintexas.gov/resource/fdj4-gpfu.json';

    // Build SoQL query with date filter
    const startDate = new Date(timeRange.start).toISOString().split('T')[0];
    const endDate = new Date(timeRange.end).toISOString().split('T')[0];

    const params = new URLSearchParams({
      $limit: '1000',
      $order: 'occ_date DESC',
      $where: `occ_date >= '${startDate}' AND occ_date <= '${endDate}'`,
    });

    const url = `${baseUrl}?${params}`;

    try {
      const reports = await this.fetchJson<AustinCrimeReport[]>(url);

      if (!reports || !Array.isArray(reports)) {
        return [];
      }

      // Check if query location is within Austin bounds
      const distanceToAustin = this.calculateDistance(
        location.latitude,
        location.longitude,
        AUSTIN_CENTER.latitude,
        AUSTIN_CENTER.longitude
      );

      // If query is too far from Austin, return empty (data is Austin-specific)
      if (distanceToAustin > COVERAGE_RADIUS_METERS) {
        return [];
      }

      // Filter by config (coordinates are not available due to privacy)
      const filtered = reports.filter((report) => {
        // Filter family violence if configured
        if (!this.crimeConfig.includeFamilyViolence && report.family_violence === 'Y') {
          return false;
        }

        // Filter by minimum risk level if configured
        if (this.crimeConfig.minRiskLevel) {
          const riskLevel = this.mapCrimeTypeToRisk(report.crime_type);
          if (!this.meetsMinRisk(riskLevel, this.crimeConfig.minRiskLevel)) {
            return false;
          }
        }

        // If we have a council district, check if within query radius
        if (report.council_district && radiusMeters < COVERAGE_RADIUS_METERS) {
          const centroid = DISTRICT_CENTROIDS[report.council_district];
          if (centroid) {
            const distance = this.calculateDistance(
              location.latitude,
              location.longitude,
              centroid.latitude,
              centroid.longitude
            );
            // Use a larger threshold since we're using district centroids
            if (distance > radiusMeters * 2) return false;
          }
        }

        return true;
      });

      return filtered.map((report) => this.transformReport(report));
    } catch (error) {
      warnings.push(
        `Failed to fetch Austin crime reports: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Transform an Austin crime report to our Alert format.
   */
  private transformReport(report: AustinCrimeReport) {
    const riskLevel = this.mapCrimeTypeToRisk(report.crime_type);

    // Use district centroid for coordinates (actual coords not available for privacy)
    const districtCentroid = report.council_district
      ? DISTRICT_CENTROIDS[report.council_district]
      : null;
    const lat = districtCentroid?.latitude ?? AUSTIN_CENTER.latitude;
    const lng = districtCentroid?.longitude ?? AUSTIN_CENTER.longitude;

    // Parse occurrence date/time
    const occDateTime = this.parseOccDateTime(report.occ_date_time, report.occ_date);

    // Determine if recent (within 24 hours)
    const isRecent = Date.now() - occDateTime.getTime() < 24 * 60 * 60 * 1000;
    const temporalType = isRecent ? 'real-time' : 'historical';

    return this.createAlert({
      id: `austin-crime-${report.incident_report_number}`,
      externalId: report.incident_report_number,
      title: this.formatCrimeType(report.crime_type),
      description: this.buildDescription(report),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'crime',
      temporalType,
      location: {
        point: { latitude: lat, longitude: lng },
        address: report.address,
        city: 'Austin',
        state: 'TX',
      },
      timestamps: {
        issued: report.rep_date,
        eventStart: occDateTime.toISOString(),
      },
      metadata: {
        incidentNumber: report.incident_report_number,
        crimeType: report.crime_type,
        ucrCode: report.ucr_code,
        familyViolence: report.family_violence === 'Y',
        locationType: report.location_type,
        sector: report.sector,
        district: report.district,
        councilDistrict: report.council_district,
        clearanceStatus: report.clearance_status,
      },
    });
  }

  /**
   * Parse occurrence date/time string.
   */
  private parseOccDateTime(occDateTime: string, occDate: string): Date {
    // Format: "01/24/2026  00:39" or fallback to occ_date
    try {
      if (occDateTime) {
        const [datePart, timePart] = occDateTime.split(/\s{2,}/);
        const [month, day, year] = datePart.split('/');
        const [hour, minute] = (timePart || '00:00').split(':');
        return new Date(
          parseInt(year),
          parseInt(month) - 1,
          parseInt(day),
          parseInt(hour),
          parseInt(minute)
        );
      }
    } catch {
      // Fall through to parse occ_date
    }

    return new Date(occDate);
  }

  /**
   * Map crime type to risk level.
   */
  private mapCrimeTypeToRisk(crimeType: string): RiskLevel {
    // Check exact match
    const upperType = crimeType.toUpperCase();
    if (CRIME_TYPE_RISK_MAP[upperType]) {
      return CRIME_TYPE_RISK_MAP[upperType];
    }

    // Check partial matches
    if (upperType.includes('MURDER') || upperType.includes('HOMICIDE')) {
      return 'extreme';
    }
    if (upperType.includes('SEXUAL') || upperType.includes('KIDNAP')) {
      return 'severe';
    }
    if (upperType.includes('AGG') && upperType.includes('ASSAULT')) {
      return 'severe';
    }
    if (upperType.includes('ROBBERY')) {
      return 'severe';
    }
    if (upperType.includes('ASSAULT')) {
      return 'high';
    }
    if (upperType.includes('BURGLARY')) {
      return 'high';
    }
    if (upperType.includes('AUTO THEFT') || upperType.includes('MOTOR VEHICLE')) {
      return 'high';
    }
    if (upperType.includes('ARSON')) {
      return 'severe';
    }
    if (upperType.includes('THEFT')) {
      return 'moderate';
    }
    if (upperType.includes('WEAPON')) {
      return 'high';
    }
    if (upperType.includes('DWI') || upperType.includes('DUI')) {
      return 'high';
    }

    return 'moderate';
  }

  /**
   * Check if a risk level meets the minimum threshold.
   */
  private meetsMinRisk(riskLevel: RiskLevel, minRisk: RiskLevel): boolean {
    const riskOrder: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'extreme'];
    const riskIndex = riskOrder.indexOf(riskLevel);
    const minIndex = riskOrder.indexOf(minRisk);
    return riskIndex >= minIndex;
  }

  /**
   * Format crime type for display.
   */
  private formatCrimeType(crimeType: string): string {
    return crimeType
      .split(/[\s-]+/)
      .map((word) => {
        if (word.length <= 2) return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ')
      .trim();
  }

  /**
   * Build description from report data.
   */
  private buildDescription(report: AustinCrimeReport): string {
    const parts: string[] = [];

    parts.push(`Crime Type: ${report.crime_type}`);

    if (report.location_type) {
      parts.push(`Location Type: ${report.location_type}`);
    }

    if (report.address) {
      parts.push(`Address: ${report.address}`);
    }

    if (report.family_violence === 'Y') {
      parts.push('Family Violence: Yes');
    }

    if (report.sector) {
      parts.push(`Sector: ${report.sector}`);
    }

    if (report.clearance_status) {
      parts.push(`Clearance Status: ${report.clearance_status}`);
    }

    parts.push(`Occurred: ${report.occ_date_time || report.occ_date}`);
    parts.push(`Reported: ${report.rep_date}`);

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
