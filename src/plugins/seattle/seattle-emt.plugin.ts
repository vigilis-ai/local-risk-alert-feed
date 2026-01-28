import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Seattle Fire 911 call from Socrata API (used for medical/EMS dispatch).
 */
interface SeattleFire911Call {
  address: string;
  type: string;
  datetime: string;
  latitude: string;
  longitude: string;
  incident_number: string;
  report_location?: {
    type: string;
    coordinates: [number, number];
  };
}

/**
 * Seattle EMT plugin configuration.
 */
export interface SeattleEMTPluginConfig extends BasePluginConfig {
  /** Include low-acuity aid responses. Default: true */
  includeLowAcuity?: boolean;
}

/**
 * Seattle, WA center coordinates.
 */
const SEATTLE_CENTER = {
  latitude: 47.6062,
  longitude: -122.3321,
};

/**
 * Coverage radius in meters (~30km covers Seattle metro).
 */
const COVERAGE_RADIUS_METERS = 30_000;

/**
 * Medical/EMS call type to risk level mapping.
 */
const MEDICAL_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  // High-acuity responses
  'Medic Response': 'high',
  'Medic Response- Loss': 'severe',
  'Medic Response- 7 Per Rule': 'severe',
  'MVI - Loss': 'severe',
  'Cardiac Arrest': 'extreme',

  // Standard responses
  'Aid Response': 'moderate',
  'Aid Response Yellow': 'moderate',
  'Aid Response- Loss': 'high',

  // Motor vehicle incidents
  'MVI': 'high',
  'MVI Freeway': 'high',
  'Motor Vehicle Accident': 'high',

  // Other medical
  'Overdose': 'high',
  'Choking': 'severe',
  'Drowning': 'severe',
  'Unconscious': 'high',
  'Difficulty Breathing': 'high',
  'Seizure': 'high',
  'Stroke': 'severe',
  'Allergic Reaction': 'high',
  'Fall': 'moderate',
  'Sick Person': 'moderate',
  'Bleeding': 'high',
  'Assault w/Weapons': 'severe',
};

/**
 * Plugin that fetches real-time medical/EMS incidents from Seattle Fire Department 911 dispatch.
 *
 * Uses the City of Seattle Open Data Portal Socrata API which updates every 5 minutes.
 * This plugin filters to medical/EMS-related incidents only (not fire).
 *
 * @see https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj
 */
export class SeattleEMTPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'seattle-emt',
    name: 'Seattle Fire Department EMS',
    version: '1.0.0',
    description: 'Real-time medical/EMS incidents from Seattle Fire Department 911 dispatch',
    coverage: {
      type: 'regional',
      center: SEATTLE_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Seattle, WA metropolitan area',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 5,
      freshnessDescription: 'Real-time updates every 5 minutes',
    },
    supportedTemporalTypes: ['real-time'],
    supportedCategories: ['medical'],
    refreshIntervalMs: 5 * 60 * 1000,
  };

  private emtConfig: SeattleEMTPluginConfig;

  constructor(config?: SeattleEMTPluginConfig) {
    super(config);
    this.emtConfig = {
      includeLowAcuity: true,
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
        () => this.fetchMedicalCalls(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Seattle EMT fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch medical/EMS 911 calls from Seattle Socrata API.
   */
  private async fetchMedicalCalls(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const baseUrl = 'https://data.seattle.gov/resource/kzjm-xkqj.json';

    // Socrata uses floating timestamps without timezone suffix
    const startDate = new Date(timeRange.start).toISOString().replace('Z', '');
    const endDate = new Date(timeRange.end).toISOString().replace('Z', '');

    const params = new URLSearchParams({
      $limit: '1000',
      $order: 'datetime DESC',
      $where: `datetime >= '${startDate}' AND datetime <= '${endDate}'`,
    });

    const url = `${baseUrl}?${params}`;

    try {
      const calls = await this.fetchJson<SeattleFire911Call[]>(url);

      if (!calls || !Array.isArray(calls)) {
        return [];
      }

      const filtered = calls.filter((call) => {
        // Must have coordinates
        const lat = parseFloat(call.latitude);
        const lng = parseFloat(call.longitude);
        if (isNaN(lat) || isNaN(lng)) return false;

        // Filter by location
        const distance = this.calculateDistance(
          location.latitude,
          location.longitude,
          lat,
          lng
        );
        if (distance > radiusMeters) return false;

        // Only include medical/EMS-related calls
        if (!this.isMedicalRelated(call.type)) return false;

        // Filter low-acuity calls if configured
        if (!this.emtConfig.includeLowAcuity) {
          if (this.isLowAcuity(call.type)) return false;
        }

        return true;
      });

      return filtered.map((call) => this.transformCall(call));
    } catch (error) {
      warnings.push(
        `Failed to fetch Seattle EMT calls: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Check if a call type is medical/EMS-related.
   */
  private isMedicalRelated(type: string): boolean {
    const upper = type.toUpperCase();

    // Include medical/EMS types
    if (upper.includes('MEDIC')) return true;
    if (upper.includes('AID')) return true;
    if (upper.includes('MEDICAL')) return true;
    if (upper.includes('MVI')) return true;
    if (upper.includes('MOTOR VEHICLE')) return true;
    if (upper.includes('CARDIAC')) return true;
    if (upper.includes('OVERDOSE')) return true;
    if (upper.includes('CHOKING')) return true;
    if (upper.includes('DROWNING')) return true;
    if (upper.includes('UNCONSCIOUS')) return true;
    if (upper.includes('BREATHING')) return true;
    if (upper.includes('SEIZURE')) return true;
    if (upper.includes('STROKE')) return true;
    if (upper.includes('ALLERGIC')) return true;
    if (upper.includes('FALL')) return true;
    if (upper.includes('SICK')) return true;
    if (upper.includes('BLEEDING')) return true;
    if (upper.includes('ASSAULT')) return true;

    return false;
  }

  /**
   * Check if a call type is low-acuity.
   */
  private isLowAcuity(type: string): boolean {
    const upper = type.toUpperCase();
    return upper === 'AID RESPONSE' ||
           upper.includes('AID RESPONSE YELLOW') ||
           upper.includes('SICK PERSON') ||
           upper.includes('FALL');
  }

  /**
   * Transform a Seattle medical/EMS 911 call to our Alert format.
   */
  private transformCall(call: SeattleFire911Call) {
    const riskLevel = this.mapTypeToRisk(call.type);
    const lat = parseFloat(call.latitude);
    const lng = parseFloat(call.longitude);

    return this.createAlert({
      id: `seattle-emt-${call.incident_number}`,
      externalId: call.incident_number,
      title: this.formatType(call.type),
      description: this.buildDescription(call),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'medical',
      temporalType: 'real-time',
      location: {
        point: { latitude: lat, longitude: lng },
        address: call.address,
        city: 'Seattle',
        state: 'WA',
      },
      timestamps: {
        issued: call.datetime,
        eventStart: call.datetime,
      },
      metadata: {
        incidentNumber: call.incident_number,
        type: call.type,
      },
    });
  }

  /**
   * Map call type to risk level.
   */
  private mapTypeToRisk(type: string): RiskLevel {
    if (MEDICAL_TYPE_RISK_MAP[type]) {
      return MEDICAL_TYPE_RISK_MAP[type];
    }

    const upper = type.toUpperCase();

    if (upper.includes('CARDIAC') || upper.includes('ARREST')) return 'extreme';
    if (upper.includes('STROKE') || upper.includes('CHOKING') || upper.includes('DROWNING')) return 'severe';
    if (upper.includes('ASSAULT') && upper.includes('WEAPON')) return 'severe';
    if (upper.includes('LOSS')) return 'severe';
    if (upper.includes('MEDIC')) return 'high';
    if (upper.includes('MVI') || upper.includes('MOTOR VEHICLE')) return 'high';
    if (upper.includes('OVERDOSE') || upper.includes('UNCONSCIOUS')) return 'high';
    if (upper.includes('BREATHING') || upper.includes('SEIZURE')) return 'high';
    if (upper.includes('BLEEDING') || upper.includes('ALLERGIC')) return 'high';
    if (upper.includes('AID')) return 'moderate';
    if (upper.includes('FALL') || upper.includes('SICK')) return 'moderate';

    return 'moderate';
  }

  /**
   * Format type for display.
   */
  private formatType(type: string): string {
    return type
      .replace(/\s*-\s*/g, ' - ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build description from call data.
   */
  private buildDescription(call: SeattleFire911Call): string {
    const parts: string[] = [];

    parts.push(`Type: ${call.type}`);
    parts.push(`Location: ${call.address}`);
    parts.push(`Reported: ${new Date(call.datetime).toLocaleString()}`);

    return parts.join('\n');
  }

  /**
   * Calculate distance between two points in meters.
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = ((lat2 - lat1) * Math.PI) / 180;
    const dl = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
              Math.cos(p1) * Math.cos(p2) *
              Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}
