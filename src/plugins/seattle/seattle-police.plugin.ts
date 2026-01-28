import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Seattle Police call data from Socrata API.
 */
interface SeattlePoliceCall {
  cad_event_number: string;
  initial_call_type: string;
  final_call_type?: string;
  priority: string;
  call_type?: string;
  cad_event_original_time_queued: string;
  cad_event_arrived_time?: string;
  dispatch_precinct?: string;
  dispatch_sector?: string;
  dispatch_beat?: string;
  dispatch_neighborhood?: string;
  dispatch_latitude?: string;
  dispatch_longitude?: string;
  dispatch_address?: string;
  call_type_indicator?: string;
}

/**
 * Seattle Police plugin configuration.
 */
export interface SeattlePolicePluginConfig extends BasePluginConfig {
  /** Include low-priority calls. Default: true */
  includeLowPriority?: boolean;
  /** Minimum SPD priority level to include (1=highest, 9=lowest). Default: undefined (all) */
  minPriority?: number;
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
 * SPD beat approximate centroids.
 * Used to assign approximate coordinates when dispatch lat/lng is not available.
 * Organized by precinct (N=North, E=East, S=South, W=West, SW=Southwest).
 */
const BEAT_CENTROIDS: Record<string, { latitude: number; longitude: number }> = {
  // North Precinct
  'N1': { latitude: 47.7068, longitude: -122.3542 },
  'N2': { latitude: 47.7068, longitude: -122.3250 },
  'N3': { latitude: 47.6900, longitude: -122.3542 },
  'J1': { latitude: 47.6640, longitude: -122.3467 },
  'J2': { latitude: 47.6640, longitude: -122.3200 },
  'J3': { latitude: 47.6500, longitude: -122.3467 },
  'L1': { latitude: 47.6800, longitude: -122.3000 },
  'L2': { latitude: 47.6700, longitude: -122.3000 },
  'L3': { latitude: 47.6600, longitude: -122.3000 },
  'U1': { latitude: 47.6580, longitude: -122.3100 },
  'U2': { latitude: 47.6650, longitude: -122.3000 },
  'U3': { latitude: 47.6500, longitude: -122.3200 },
  'B1': { latitude: 47.6750, longitude: -122.3800 },
  'B2': { latitude: 47.6750, longitude: -122.3600 },
  'B3': { latitude: 47.6650, longitude: -122.3700 },
  // East Precinct
  'C1': { latitude: 47.6150, longitude: -122.3200 },
  'C2': { latitude: 47.6150, longitude: -122.3050 },
  'C3': { latitude: 47.6050, longitude: -122.3200 },
  'E1': { latitude: 47.6200, longitude: -122.3000 },
  'E2': { latitude: 47.6200, longitude: -122.2850 },
  'E3': { latitude: 47.6100, longitude: -122.3000 },
  'G1': { latitude: 47.6350, longitude: -122.2800 },
  'G2': { latitude: 47.6350, longitude: -122.2650 },
  'G3': { latitude: 47.6250, longitude: -122.2800 },
  // South Precinct
  'R1': { latitude: 47.5500, longitude: -122.2850 },
  'R2': { latitude: 47.5500, longitude: -122.2650 },
  'R3': { latitude: 47.5350, longitude: -122.2850 },
  'S1': { latitude: 47.5650, longitude: -122.2850 },
  'S2': { latitude: 47.5650, longitude: -122.2650 },
  'S3': { latitude: 47.5500, longitude: -122.2850 },
  'O1': { latitude: 47.5800, longitude: -122.3200 },
  'O2': { latitude: 47.5800, longitude: -122.3000 },
  'O3': { latitude: 47.5700, longitude: -122.3200 },
  // West Precinct
  'D1': { latitude: 47.6100, longitude: -122.3400 },
  'D2': { latitude: 47.6100, longitude: -122.3550 },
  'D3': { latitude: 47.6000, longitude: -122.3400 },
  'K1': { latitude: 47.6300, longitude: -122.3550 },
  'K2': { latitude: 47.6300, longitude: -122.3700 },
  'K3': { latitude: 47.6200, longitude: -122.3550 },
  'M1': { latitude: 47.6400, longitude: -122.3550 },
  'M2': { latitude: 47.6400, longitude: -122.3700 },
  'M3': { latitude: 47.6300, longitude: -122.3550 },
  'Q1': { latitude: 47.6300, longitude: -122.3900 },
  'Q2': { latitude: 47.6300, longitude: -122.4050 },
  'Q3': { latitude: 47.6200, longitude: -122.3900 },
  // Southwest Precinct
  'F1': { latitude: 47.5700, longitude: -122.3700 },
  'F2': { latitude: 47.5700, longitude: -122.3550 },
  'F3': { latitude: 47.5600, longitude: -122.3700 },
  'W1': { latitude: 47.5650, longitude: -122.3850 },
  'W2': { latitude: 47.5550, longitude: -122.3850 },
  'W3': { latitude: 47.5450, longitude: -122.3850 },
};

/**
 * Call type to risk level and category mapping.
 */
const CALL_TYPE_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  // Violent crimes - severe/extreme
  'SHOOTING': { category: 'crime', risk: 'extreme' },
  'SHOTS FIRED': { category: 'crime', risk: 'extreme' },
  'HOMICIDE': { category: 'crime', risk: 'extreme' },
  'STABBING': { category: 'crime', risk: 'extreme' },
  'ASSAULT': { category: 'crime', risk: 'severe' },
  'ASSAULT - IP': { category: 'crime', risk: 'severe' },
  'ASSAULT W/WEAPON': { category: 'crime', risk: 'extreme' },
  'ROBBERY': { category: 'crime', risk: 'severe' },
  'ROBBERY - IP': { category: 'crime', risk: 'severe' },
  'KIDNAPPING': { category: 'crime', risk: 'severe' },
  'SEXUAL ASSAULT': { category: 'crime', risk: 'severe' },
  'DOMESTIC VIOLENCE': { category: 'crime', risk: 'severe' },
  'DV - IP': { category: 'crime', risk: 'severe' },

  // Property crimes - high
  'BURGLARY': { category: 'crime', risk: 'high' },
  'BURGLARY - IP': { category: 'crime', risk: 'high' },
  'AUTO THEFT': { category: 'crime', risk: 'high' },
  'AUTO THEFT - IP': { category: 'crime', risk: 'high' },
  'ARSON': { category: 'crime', risk: 'severe' },
  'CARJACK': { category: 'crime', risk: 'severe' },

  // Moderate crimes
  'THEFT': { category: 'crime', risk: 'moderate' },
  'THEFT - IP': { category: 'crime', risk: 'moderate' },
  'SHOPLIFTING': { category: 'crime', risk: 'low' },
  'VANDALISM': { category: 'crime', risk: 'moderate' },
  'CRIMINAL MISCHIEF': { category: 'crime', risk: 'moderate' },
  'FRAUD': { category: 'crime', risk: 'moderate' },
  'TRESPASS': { category: 'crime', risk: 'low' },

  // Disorder
  'DISTURBANCE': { category: 'crime', risk: 'moderate' },
  'FIGHT': { category: 'crime', risk: 'high' },
  'THREATS': { category: 'crime', risk: 'high' },
  'SUSPICIOUS': { category: 'crime', risk: 'moderate' },
  'SUSPICIOUS PERSON': { category: 'crime', risk: 'moderate' },
  'SUSPICIOUS VEHICLE': { category: 'crime', risk: 'moderate' },
  'PERSON WITH WEAPON': { category: 'crime', risk: 'severe' },
  'WEAPON': { category: 'crime', risk: 'severe' },
  'PROWLER': { category: 'crime', risk: 'high' },
  'HARASSMENT': { category: 'crime', risk: 'moderate' },

  // Traffic related
  'TRAFFIC': { category: 'traffic', risk: 'moderate' },
  'DUI': { category: 'traffic', risk: 'high' },
  'HIT AND RUN': { category: 'traffic', risk: 'high' },
  'RECKLESS DRIVING': { category: 'traffic', risk: 'high' },
  'ACCIDENT': { category: 'traffic', risk: 'moderate' },

  // SPD abbreviated call types
  'ASLT - CRITICAL (NO SHOOTINGS)': { category: 'crime', risk: 'severe' },
  'ASLT - WITH OR W/O WPNS (NO SHOOTINGS)': { category: 'crime', risk: 'severe' },
  'ASLT - DV - IP': { category: 'crime', risk: 'severe' },
  'ASLT - DV': { category: 'crime', risk: 'severe' },
  'BURG - RESIDENTIAL': { category: 'crime', risk: 'high' },
  'BURG - COMMERCIAL': { category: 'crime', risk: 'high' },
  'THEFT - AUTO': { category: 'crime', risk: 'high' },
  'ROBB - IP': { category: 'crime', risk: 'severe' },
  'NARC - ACTIVITY': { category: 'crime', risk: 'moderate' },
  'SHOOTINGS': { category: 'crime', risk: 'extreme' },
  'SHOTS FIRED (NO VICTIMS)': { category: 'crime', risk: 'extreme' },
  'PERSON WITH WEAPON - IP': { category: 'crime', risk: 'severe' },
  'TRAFFIC STOP - OFFICER INITIATED ONVIEW': { category: 'traffic', risk: 'low' },

  // Other
  'WELFARE CHECK': { category: 'other', risk: 'moderate' },
  'MENTAL': { category: 'other', risk: 'moderate' },
  'CRISIS': { category: 'other', risk: 'high' },
  'NOISE': { category: 'other', risk: 'low' },
  'ALARM': { category: 'crime', risk: 'low' },
  'HAZARD': { category: 'other', risk: 'moderate' },
  'NARCOTICS': { category: 'crime', risk: 'moderate' },
  'DRUG': { category: 'crime', risk: 'moderate' },
};

/**
 * Low priority call types that can be filtered out.
 */
const LOW_PRIORITY_TYPES = new Set([
  'NOISE',
  'PARKING',
  'ALARM',
  'ANIMAL',
  'ABANDONED VEHICLE',
  'INFORMATION',
  'FOUND PROPERTY',
  'LOST PROPERTY',
]);

/**
 * Plugin that fetches police calls for service from Seattle Police Department.
 *
 * Uses the City of Seattle Open Data Portal Socrata API.
 * Location data is blurred to the hundred-block level for community privacy.
 * When dispatch coordinates are not available, beat centroids are used.
 *
 * @see https://data.seattle.gov/Public-Safety/Call-Data/33kz-ixgy
 */
export class SeattlePolicePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'seattle-police',
    name: 'Seattle Police Department',
    version: '1.0.0',
    description: 'Police calls for service from Seattle Police Department',
    coverage: {
      type: 'regional',
      center: SEATTLE_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Seattle, WA metropolitan area',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 60,
      freshnessDescription: 'Updated approximately hourly',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['crime', 'traffic', 'other'],
    refreshIntervalMs: 15 * 60 * 1000,
    defaultRadiusMeters: 1_000,
  };

  private policeConfig: SeattlePolicePluginConfig;

  constructor(config?: SeattlePolicePluginConfig) {
    super(config);
    this.policeConfig = {
      includeLowPriority: true,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters, timeRange, categories } = options;
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchPoliceCalls(location, radiusMeters, timeRange, categories, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('Seattle Police fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch police calls from Seattle Socrata API.
   */
  private async fetchPoliceCalls(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    categories: AlertCategory[] | undefined,
    warnings: string[]
  ) {
    const baseUrl = 'https://data.seattle.gov/resource/33kz-ixgy.json';

    // Socrata uses floating timestamps without timezone suffix
    const startDate = new Date(timeRange.start).toISOString().replace('Z', '');
    const endDate = new Date(timeRange.end).toISOString().replace('Z', '');

    const params = new URLSearchParams({
      $limit: '1000',
      $order: 'cad_event_original_time_queued DESC',
      $where: `cad_event_original_time_queued >= '${startDate}' AND cad_event_original_time_queued <= '${endDate}'`,
    });

    const url = `${baseUrl}?${params}`;

    try {
      const calls = await this.fetchJson<SeattlePoliceCall[]>(url);

      if (!calls || !Array.isArray(calls)) {
        return [];
      }

      const filtered = calls.filter((call) => {
        // Get coordinates (dispatch lat/lng or beat centroid fallback)
        const coords = this.getCallCoordinates(call);
        if (!coords) return false;

        // Filter by location
        const distance = this.calculateDistance(
          location.latitude,
          location.longitude,
          coords.latitude,
          coords.longitude
        );
        if (distance > radiusMeters) return false;

        // Filter low priority if configured
        if (!this.policeConfig.includeLowPriority) {
          const callType = (call.initial_call_type || '').toUpperCase();
          if (LOW_PRIORITY_TYPES.has(callType)) return false;
        }

        // Filter by minimum priority if configured
        if (this.policeConfig.minPriority) {
          const priority = parseInt(call.priority);
          if (!isNaN(priority) && priority > this.policeConfig.minPriority) return false;
        }

        // Filter by categories if specified
        if (categories && categories.length > 0) {
          const alertCategory = this.mapCallTypeToCategory(call.initial_call_type || '');
          if (!categories.includes(alertCategory)) return false;
        }

        return true;
      });

      return filtered.map((call) => this.transformCall(call));
    } catch (error) {
      warnings.push(
        `Failed to fetch Seattle police calls: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Get coordinates for a call, using dispatch lat/lng or beat centroid fallback.
   */
  private getCallCoordinates(call: SeattlePoliceCall): { latitude: number; longitude: number } | null {
    // Try dispatch coordinates first
    if (call.dispatch_latitude && call.dispatch_longitude) {
      const lat = parseFloat(call.dispatch_latitude);
      const lng = parseFloat(call.dispatch_longitude);
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        return { latitude: lat, longitude: lng };
      }
    }

    // Fallback to beat centroid
    if (call.dispatch_beat) {
      const centroid = BEAT_CENTROIDS[call.dispatch_beat];
      if (centroid) return centroid;
    }

    return null;
  }

  /**
   * Map call type to alert category.
   */
  private mapCallTypeToCategory(callType: string): AlertCategory {
    const upper = callType.toUpperCase();

    // Check exact match
    if (CALL_TYPE_MAP[upper]) return CALL_TYPE_MAP[upper].category;

    // Keyword-based mapping
    if (upper.includes('TRAFFIC') || upper.includes('DUI') || upper.includes('ACCIDENT') || upper.includes('HIT AND RUN')) {
      return 'traffic';
    }
    if (upper.includes('WELFARE') || upper.includes('MENTAL') || upper.includes('CRISIS') || upper.includes('NOISE') || upper.includes('HAZARD')) {
      return 'other';
    }

    return 'crime';
  }

  /**
   * Transform a Seattle police call to our Alert format.
   */
  private transformCall(call: SeattlePoliceCall) {
    const { category, risk } = this.mapCallTypeToRisk(call.initial_call_type || 'UNKNOWN');
    const coords = this.getCallCoordinates(call)!;

    const issued = call.cad_event_original_time_queued;

    // Determine if recent (within last 2 hours)
    const isRecent = Date.now() - new Date(issued).getTime() < 2 * 60 * 60 * 1000;
    const temporalType = isRecent ? 'real-time' : 'historical';

    return this.createAlert({
      id: `seattle-police-${call.cad_event_number}`,
      externalId: call.cad_event_number,
      title: this.formatCallType(call.initial_call_type || call.final_call_type || 'Unknown'),
      description: this.buildDescription(call),
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType,
      location: {
        point: coords,
        address: call.dispatch_address,
        city: 'Seattle',
        state: 'WA',
      },
      timestamps: {
        issued,
        eventStart: issued,
      },
      metadata: {
        cadEventNumber: call.cad_event_number,
        initialCallType: call.initial_call_type,
        finalCallType: call.final_call_type,
        spdPriority: call.priority,
        precinct: call.dispatch_precinct,
        sector: call.dispatch_sector,
        beat: call.dispatch_beat,
        neighborhood: call.dispatch_neighborhood,
        callTypeIndicator: call.call_type_indicator,
      },
    });
  }

  /**
   * Map call type to risk level and category.
   */
  private mapCallTypeToRisk(callType: string): { category: AlertCategory; risk: RiskLevel } {
    const upper = callType.toUpperCase();

    // Check exact match
    if (CALL_TYPE_MAP[upper]) return CALL_TYPE_MAP[upper];

    // Keyword-based mapping
    // Check for shootings (but not "NO SHOOTINGS" which indicates non-shooting assault)
    const hasShootingContext = (upper.includes('SHOOT') || upper.includes('SHOT')) && !upper.includes('NO SHOOT');
    if (hasShootingContext || upper.includes('HOMICIDE')) {
      return { category: 'crime', risk: 'extreme' };
    }
    if (upper.includes('STAB') || upper.includes('CARJACK')) {
      return { category: 'crime', risk: 'extreme' };
    }
    if (upper.includes('ASSAULT') || upper.includes('ASLT') || upper.includes('ROBBERY') || upper.includes('ROBB') || upper.includes('KIDNAP')) {
      return { category: 'crime', risk: 'severe' };
    }
    if (upper.includes('WEAPON') || upper.includes('WPNS') || upper.includes('DOMESTIC')) {
      return { category: 'crime', risk: 'severe' };
    }
    if (upper.includes('BURGLARY') || upper.includes('AUTO THEFT') || upper.includes('PROWLER')) {
      return { category: 'crime', risk: 'high' };
    }
    if (upper.includes('FIGHT') || upper.includes('THREAT') || upper.includes('DUI')) {
      return { category: 'crime', risk: 'high' };
    }
    if (upper.includes('SUSPICIOUS') || upper.includes('DISTURBANCE') || upper.includes('VANDALISM')) {
      return { category: 'crime', risk: 'moderate' };
    }
    if (upper.includes('THEFT') || upper.includes('FRAUD') || upper.includes('HARASSMENT')) {
      return { category: 'crime', risk: 'moderate' };
    }
    if (upper.includes('TRAFFIC') || upper.includes('ACCIDENT') || upper.includes('HIT AND RUN')) {
      return { category: 'traffic', risk: 'moderate' };
    }
    if (upper.includes('NOISE') || upper.includes('PARKING') || upper.includes('ALARM')) {
      return { category: 'other', risk: 'low' };
    }

    return { category: 'crime', risk: 'moderate' };
  }

  /**
   * Format call type for display.
   */
  private formatCallType(callType: string): string {
    return callType
      .replace(/\s*-\s*IP$/i, ' (In Progress)')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build description from call data.
   */
  private buildDescription(call: SeattlePoliceCall): string {
    const parts: string[] = [];

    parts.push(`Call Type: ${call.initial_call_type || 'Unknown'}`);

    if (call.final_call_type && call.final_call_type !== call.initial_call_type) {
      parts.push(`Final Type: ${call.final_call_type}`);
    }

    parts.push(`Priority: ${call.priority}`);

    if (call.dispatch_address) {
      parts.push(`Address: ${call.dispatch_address}`);
    }

    if (call.dispatch_neighborhood) {
      parts.push(`Neighborhood: ${call.dispatch_neighborhood}`);
    }

    if (call.dispatch_beat) {
      parts.push(`Beat: ${call.dispatch_beat}`);
    }

    parts.push(`Queued: ${new Date(call.cad_event_original_time_queued).toLocaleString()}`);

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
