import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Bend Police call for service from ArcGIS service.
 */
interface BendPoliceCall {
  OBJECTID: number;
  IncidentNumber: string;
  CreateDateTime: number; // Unix timestamp in ms
  Day_of_Week: string;
  CallType: string;
  GlobalID: string;
  CallAddress: string;
  Hour: number;
  Neighborhood: string | null;
}

/**
 * ArcGIS GeoJSON response.
 */
interface ArcGISResponse {
  features: Array<{
    attributes: BendPoliceCall;
    geometry?: {
      x: number; // Web Mercator X
      y: number; // Web Mercator Y
    };
  }>;
  exceededTransferLimit?: boolean;
}

/**
 * Bend Police plugin configuration.
 */
export interface BendPolicePluginConfig extends BasePluginConfig {
  /** Maximum records to fetch per request. Default: 500 */
  limit?: number;
  /** Include low-priority calls (parking, noise). Default: true */
  includeLowPriority?: boolean;
}

/**
 * Bend, OR center coordinates.
 */
const BEND_CENTER = {
  latitude: 44.0582,
  longitude: -121.3153,
};

/**
 * Coverage radius in meters (approximately 25km covers greater Bend area).
 */
const COVERAGE_RADIUS_METERS = 25_000;

/**
 * Call type to risk level and category mapping.
 */
const CALL_TYPE_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  // High priority calls
  'Burglary': { category: 'crime', risk: 'high' },
  'Assault': { category: 'crime', risk: 'severe' },
  'DUI Driving Under the Influence': { category: 'crime', risk: 'high' },
  'Harassment': { category: 'crime', risk: 'moderate' },
  'Criminal Mischief': { category: 'crime', risk: 'moderate' },
  'Theft': { category: 'crime', risk: 'moderate' },
  'Prowler': { category: 'crime', risk: 'high' },

  // Medium priority calls
  'Suspicious Circumstances': { category: 'crime', risk: 'moderate' },
  'Dispute': { category: 'crime', risk: 'moderate' },
  'Civil Dispute': { category: 'crime', risk: 'low' },
  'Unwanted Subject': { category: 'crime', risk: 'moderate' },
  'Welfare Check': { category: 'other', risk: 'moderate' },

  // Traffic related
  'MVA Non Injury': { category: 'traffic', risk: 'moderate' },
  'Hazard': { category: 'traffic', risk: 'moderate' },

  // Low priority calls
  'Alarm': { category: 'crime', risk: 'low' },
  'Alarm - Burglary': { category: 'crime', risk: 'moderate' },
  'Alarm - Priority': { category: 'crime', risk: 'moderate' },
  'Animal Complaint': { category: 'other', risk: 'low' },
  'Dog Complaint': { category: 'other', risk: 'low' },
  'Noise Complaint': { category: 'other', risk: 'low' },
  'Parking Complaint': { category: 'traffic', risk: 'low' },
  'Abandoned Vehicle': { category: 'traffic', risk: 'low' },
  'Information Only': { category: 'other', risk: 'low' },

  // Medical/Fire assist
  'Assist to Fire (Law)': { category: 'fire', risk: 'moderate' },
  'Assist to Medics (Law)': { category: 'medical', risk: 'moderate' },
  'Assist - Police': { category: 'crime', risk: 'moderate' },

  // Other
  '911 Abandoned': { category: 'other', risk: 'low' },
  'Unknown Problem': { category: 'other', risk: 'moderate' },
};

/**
 * Low priority call types that can be filtered out.
 */
const LOW_PRIORITY_TYPES = new Set([
  'Noise Complaint',
  'Parking Complaint',
  'Abandoned Vehicle',
  'Information Only',
  'Animal Complaint',
  'Dog Complaint',
  '911 Abandoned',
  'C6 Follow-Up',
]);

/**
 * Plugin that fetches police calls for service from Bend, Oregon Police Department ArcGIS service.
 *
 * Uses the Bend Police public calls for service endpoint which is updated in near real-time.
 *
 * @see https://policedata.bendoregon.gov/
 */
export class BendPolicePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'bend-police',
    name: 'Bend Police Department',
    version: '1.0.0',
    description: 'Police calls for service from Bend, Oregon Police Department',
    coverage: {
      type: 'regional',
      center: BEND_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Bend, Oregon and surrounding areas',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['crime', 'traffic', 'other'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
  };

  private policeConfig: BendPolicePluginConfig;

  constructor(config?: BendPolicePluginConfig) {
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
      console.error('Bend Police fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch calls from Bend Police ArcGIS service.
   */
  private async fetchCalls(
    location: { latitude: number; longitude: number },
    timeRange: { start: string; end: string },
    radiusMeters: number,
    categories?: AlertCategory[]
  ) {
    // Bend Police public calls for service
    const baseUrl = 'https://services5.arcgis.com/JisFYcK2mIVg9ueP/arcgis/rest/services/Public_Calls/FeatureServer/0/query';

    // Build where clause - use OBJECTID > 0 since date filtering isn't supported
    // We'll filter by time range client-side
    const startDate = new Date(timeRange.start);
    const endDate = new Date(timeRange.end);
    const startTs = startDate.getTime();
    const endTs = endDate.getTime();

    const params = new URLSearchParams({
      where: 'OBJECTID > 0',
      outFields: '*',
      f: 'json',
      outSR: '4326', // Request WGS84 coordinates
      resultRecordCount: String(this.policeConfig.limit),
      orderByFields: 'CreateDateTime DESC',
    });

    const url = `${baseUrl}?${params}`;
    const response = await this.fetchJson<ArcGISResponse>(url);

    if (!response.features) {
      return [];
    }

    // Transform and filter by location and time range
    const alerts = response.features
      .filter(f => {
        if (!f.geometry) return false;

        // Filter by time range (client-side since ArcGIS doesn't support date filtering)
        const callTime = f.attributes.CreateDateTime;
        if (callTime < startTs || callTime > endTs) return false;

        // Geometry is already in WGS84 (outSR=4326)
        // x = longitude, y = latitude
        const coords = {
          latitude: f.geometry.y,
          longitude: f.geometry.x,
        };

        const distance = this.calculateDistance(
          location.latitude,
          location.longitude,
          coords.latitude,
          coords.longitude
        );

        if (distance > radiusMeters) return false;

        // Filter low priority if configured
        if (!this.policeConfig.includeLowPriority) {
          if (LOW_PRIORITY_TYPES.has(f.attributes.CallType)) return false;
        }

        // Filter by categories if specified
        if (categories && categories.length > 0) {
          const alertCategory = this.mapCallTypeToCategory(f.attributes.CallType);
          if (!categories.includes(alertCategory)) return false;
        }

        return true;
      })
      .map(f => {
        // Geometry is already in WGS84 (outSR=4326)
        const coords = {
          latitude: f.geometry!.y,
          longitude: f.geometry!.x,
        };
        return this.transformCall(f.attributes, coords);
      });

    return alerts;
  }

  /**
   * Map call type to alert category.
   */
  private mapCallTypeToCategory(callType: string): AlertCategory {
    const mapping = CALL_TYPE_MAP[callType];
    if (mapping) return mapping.category;

    // Default categorization based on keywords
    const lowerType = callType.toLowerCase();
    if (lowerType.includes('traffic') || lowerType.includes('mva') || lowerType.includes('vehicle')) {
      return 'traffic';
    }
    if (lowerType.includes('fire') || lowerType.includes('medic')) {
      return 'fire';
    }
    return 'crime';
  }

  /**
   * Transform a Bend Police call to our Alert format.
   */
  private transformCall(
    call: BendPoliceCall,
    coordinates: { latitude: number; longitude: number }
  ) {
    const { category, risk } = this.mapCallTypeToRisk(call.CallType);

    // Parse timestamp
    const issued = new Date(call.CreateDateTime).toISOString();

    // Determine if real-time (within last 24 hours)
    const isRecent = Date.now() - call.CreateDateTime < 24 * 60 * 60 * 1000;
    const temporalType = isRecent ? 'real-time' : 'historical';

    return this.createAlert({
      id: `bend-police-${call.IncidentNumber}`,
      externalId: call.IncidentNumber,
      title: this.formatCallType(call.CallType),
      description: this.buildDescription(call),
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType,
      location: {
        point: coordinates,
        address: call.CallAddress,
        city: 'Bend',
        state: 'OR',
      },
      timestamps: {
        issued,
        eventStart: issued,
      },
      metadata: {
        incidentNumber: call.IncidentNumber,
        callType: call.CallType,
        dayOfWeek: call.Day_of_Week,
        hour: call.Hour,
        neighborhood: call.Neighborhood,
      },
    });
  }

  /**
   * Map call type to risk level.
   */
  private mapCallTypeToRisk(callType: string): { category: AlertCategory; risk: RiskLevel } {
    const mapping = CALL_TYPE_MAP[callType];
    if (mapping) return mapping;

    // Default mapping based on keywords
    const lowerType = callType.toLowerCase();

    if (lowerType.includes('assault') || lowerType.includes('robbery') || lowerType.includes('weapon')) {
      return { category: 'crime', risk: 'severe' };
    }
    if (lowerType.includes('burglary') || lowerType.includes('theft') || lowerType.includes('dui')) {
      return { category: 'crime', risk: 'high' };
    }
    if (lowerType.includes('suspicious') || lowerType.includes('dispute') || lowerType.includes('unwanted')) {
      return { category: 'crime', risk: 'moderate' };
    }
    if (lowerType.includes('traffic') || lowerType.includes('mva')) {
      return { category: 'traffic', risk: 'moderate' };
    }

    return { category: 'crime', risk: 'low' };
  }

  /**
   * Format call type for display.
   */
  private formatCallType(callType: string): string {
    // Clean up call type for display
    return callType
      .replace(/\s+Call$/, '')
      .replace(/^TS\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build description from call data.
   */
  private buildDescription(call: BendPoliceCall): string {
    const parts: string[] = [];

    parts.push(`Call Type: ${call.CallType}`);

    if (call.Neighborhood) {
      parts.push(`Neighborhood: ${call.Neighborhood}`);
    }

    parts.push(`Day: ${call.Day_of_Week}`);
    parts.push(`Time: ${call.Hour}:00`);

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
