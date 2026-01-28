import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Seattle Fire 911 call from Socrata API.
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
 * Seattle Fire plugin configuration.
 */
export interface SeattleFirePluginConfig extends BasePluginConfig {
  /** Include alarm calls (often false alarms). Default: true */
  includeAlarms?: boolean;
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
 * Fire incident type to risk level mapping.
 */
const FIRE_TYPE_RISK_MAP: Record<string, RiskLevel> = {
  // Structure fires
  'Residential Fire': 'severe',
  'Commercial Fire': 'severe',
  'Fire in Building': 'severe',
  'Chimney Fire': 'high',

  // Vehicle/outdoor fires
  'Car Fire': 'high',
  'Auto Fire Freeway': 'high',
  'Brush Fire': 'high',
  'Rubbish Fire': 'moderate',
  'Dumpster Fire': 'moderate',

  // Alarms
  'Fire Alarm': 'low',
  'Automatic Fire Alarm': 'low',
  'Alarm Bell': 'low',

  // Hazmat
  'Hazmat': 'severe',
  'Hazmat - Loss/Spill': 'severe',
  'Gas Leak': 'high',
  'Natural Gas Leak': 'high',
  'Carbon Monoxide': 'high',

  // Rescue
  'Rescue Heavy': 'severe',
  'Water Rescue': 'severe',
  'Confined Space': 'severe',
  'Rescue Elevator': 'moderate',
  'Rescue Lock-In': 'low',

  // Electrical
  'Electrical Fire': 'high',
  'Power Line Down': 'moderate',
  'Electrical Problem': 'moderate',
  'Wires Down': 'moderate',

  // Investigations
  'Smoke Investigation': 'moderate',
  'Investigate Out': 'low',
  'Investigation': 'low',
};

/**
 * Plugin that fetches real-time fire incidents from Seattle Fire Department 911 dispatch.
 *
 * Uses the City of Seattle Open Data Portal Socrata API which updates every 5 minutes.
 * This plugin filters to fire-related incidents only (not medical/EMS).
 *
 * @see https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj
 */
export class SeattleFirePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'seattle-fire',
    name: 'Seattle Fire Department',
    version: '1.0.0',
    description: 'Real-time fire incidents from Seattle Fire Department 911 dispatch',
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
    supportedCategories: ['fire'],
    refreshIntervalMs: 5 * 60 * 1000,
    defaultRadiusMeters: 1_000,
  };

  private fireConfig: SeattleFirePluginConfig;

  constructor(config?: SeattleFirePluginConfig) {
    super(config);
    this.fireConfig = {
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
        () => this.fetchFireCalls(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Seattle Fire fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch fire 911 calls from Seattle Socrata API, filtered to fire-related types.
   */
  private async fetchFireCalls(
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

        // Only include fire-related calls (exclude medical/EMS)
        if (!this.isFireRelated(call.type)) return false;

        // Filter alarm calls if configured
        if (!this.fireConfig.includeAlarms) {
          if (this.isAlarmCall(call.type)) return false;
        }

        return true;
      });

      return filtered.map((call) => this.transformCall(call));
    } catch (error) {
      warnings.push(
        `Failed to fetch Seattle fire calls: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Check if a call type is fire-related (not medical/EMS).
   */
  private isFireRelated(type: string): boolean {
    const upper = type.toUpperCase();

    // Exclude medical/EMS types
    if (upper.includes('MEDIC') || upper.includes('AID') || upper.includes('MEDICAL')) return false;
    if (upper.includes('MVI') && !upper.includes('FIRE')) return false;
    if (upper === 'AID RESPONSE' || upper === 'MEDIC RESPONSE') return false;

    // Include fire-related types
    if (upper.includes('FIRE')) return true;
    if (upper.includes('ALARM')) return true;
    if (upper.includes('HAZMAT') || upper.includes('HAZ')) return true;
    if (upper.includes('GAS LEAK') || upper.includes('NATURAL GAS')) return true;
    if (upper.includes('CARBON MONOXIDE')) return true;
    if (upper.includes('RESCUE')) return true;
    if (upper.includes('SMOKE')) return true;
    if (upper.includes('ELECTRICAL') || upper.includes('WIRES') || upper.includes('POWER LINE')) return true;
    if (upper.includes('INVESTIGATE') || upper.includes('INVESTIGATION')) return true;
    if (upper.includes('BRUSH') || upper.includes('RUBBISH') || upper.includes('DUMPSTER')) return true;
    if (upper.includes('CHIMNEY')) return true;
    if (upper.includes('CONFINED SPACE')) return true;
    if (upper.includes('WATER RESCUE')) return true;

    return false;
  }

  /**
   * Check if a call type is an alarm call.
   */
  private isAlarmCall(type: string): boolean {
    const upper = type.toUpperCase();
    return upper.includes('ALARM') || upper.includes('ALARM BELL');
  }

  /**
   * Transform a Seattle fire 911 call to our Alert format.
   */
  private transformCall(call: SeattleFire911Call) {
    const riskLevel = this.mapTypeToRisk(call.type);
    const lat = parseFloat(call.latitude);
    const lng = parseFloat(call.longitude);

    return this.createAlert({
      id: `seattle-fire-${call.incident_number}`,
      externalId: call.incident_number,
      title: this.formatType(call.type),
      description: this.buildDescription(call),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'fire',
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
    if (FIRE_TYPE_RISK_MAP[type]) {
      return FIRE_TYPE_RISK_MAP[type];
    }

    const upper = type.toUpperCase();

    if (upper.includes('STRUCTURE') || upper.includes('BUILDING')) return 'severe';
    if (upper.includes('WILDLAND') || upper.includes('WILDFIRE')) return 'severe';
    if (upper.includes('HAZMAT') || upper.includes('HAZARDOUS')) return 'severe';
    if (upper.includes('RESCUE HEAVY') || upper.includes('WATER RESCUE')) return 'severe';
    if (upper.includes('CONFINED SPACE')) return 'severe';
    if (upper.includes('FIRE') && !upper.includes('ALARM')) return 'high';
    if (upper.includes('GAS') || upper.includes('LEAK')) return 'high';
    if (upper.includes('CARBON MONOXIDE')) return 'high';
    if (upper.includes('RESCUE')) return 'high';
    if (upper.includes('ELECTRICAL') || upper.includes('WIRES') || upper.includes('POWER LINE')) return 'moderate';
    if (upper.includes('SMOKE')) return 'moderate';
    if (upper.includes('ALARM')) return 'low';
    if (upper.includes('INVESTIGATE')) return 'low';

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
