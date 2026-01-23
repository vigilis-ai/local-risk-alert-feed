import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Phoenix Fire incident response from Socrata API.
 */
interface PhoenixFireIncident {
  incident_number: string;
  call_type?: string;
  call_type_final?: string;
  address?: string;
  city?: string;
  zip?: string;
  incident_date?: string;
  dispatch_time?: string;
  arrival_time?: string;
  clear_time?: string;
  latitude?: string;
  longitude?: string;
  priority?: string;
  station?: string;
  battalion?: string;
}

/**
 * Phoenix Fire plugin configuration.
 */
export interface PhoenixFirePluginConfig extends BasePluginConfig {
  /** Socrata app token for higher rate limits (optional) */
  appToken?: string;
  /** Maximum records to fetch per request. Default: 1000 */
  limit?: number;
}

/**
 * Phoenix center coordinates.
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
 * Call type to category and risk mappings.
 */
const CALL_TYPE_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  // Fire-related
  STRUCTURE_FIRE: { category: 'fire', risk: 'extreme' },
  'STRUCTURE FIRE': { category: 'fire', risk: 'extreme' },
  FIRE: { category: 'fire', risk: 'severe' },
  BRUSH_FIRE: { category: 'fire', risk: 'severe' },
  'BRUSH FIRE': { category: 'fire', risk: 'severe' },
  VEHICLE_FIRE: { category: 'fire', risk: 'high' },
  'VEHICLE FIRE': { category: 'fire', risk: 'high' },
  DUMPSTER_FIRE: { category: 'fire', risk: 'moderate' },
  'DUMPSTER FIRE': { category: 'fire', risk: 'moderate' },
  SMOKE_INVESTIGATION: { category: 'fire', risk: 'moderate' },
  'SMOKE INVESTIGATION': { category: 'fire', risk: 'moderate' },
  ALARM: { category: 'fire', risk: 'low' },
  'FIRE ALARM': { category: 'fire', risk: 'low' },

  // Medical-related
  CARDIAC: { category: 'medical', risk: 'severe' },
  'CARDIAC ARREST': { category: 'medical', risk: 'severe' },
  STROKE: { category: 'medical', risk: 'severe' },
  TRAUMA: { category: 'medical', risk: 'severe' },
  'MAJOR TRAUMA': { category: 'medical', risk: 'severe' },
  MEDICAL: { category: 'medical', risk: 'high' },
  'MEDICAL AID': { category: 'medical', risk: 'high' },
  'MEDICAL EMERGENCY': { category: 'medical', risk: 'high' },
  OVERDOSE: { category: 'medical', risk: 'high' },
  'DRUG OVERDOSE': { category: 'medical', risk: 'high' },
  BREATHING: { category: 'medical', risk: 'high' },
  'BREATHING PROBLEMS': { category: 'medical', risk: 'high' },
  UNCONSCIOUS: { category: 'medical', risk: 'high' },
  'UNCONSCIOUS PERSON': { category: 'medical', risk: 'high' },
  FALL: { category: 'medical', risk: 'moderate' },
  SICK: { category: 'medical', risk: 'moderate' },
  'SICK PERSON': { category: 'medical', risk: 'moderate' },
  TRANSFER: { category: 'medical', risk: 'low' },
  'PATIENT TRANSFER': { category: 'medical', risk: 'low' },

  // Traffic/accident-related (categorize as medical for injuries)
  ACCIDENT: { category: 'medical', risk: 'high' },
  'TRAFFIC ACCIDENT': { category: 'medical', risk: 'high' },
  'MOTOR VEHICLE ACCIDENT': { category: 'medical', risk: 'high' },
  MVA: { category: 'medical', risk: 'high' },
  EXTRICATION: { category: 'medical', risk: 'severe' },
  'VEHICLE EXTRICATION': { category: 'medical', risk: 'severe' },

  // Hazmat
  HAZMAT: { category: 'fire', risk: 'severe' },
  'HAZARDOUS MATERIALS': { category: 'fire', risk: 'severe' },
  'GAS LEAK': { category: 'fire', risk: 'high' },
  'CARBON MONOXIDE': { category: 'fire', risk: 'high' },
};

/**
 * Plugin that fetches fire and EMS incident data from Phoenix Open Data Portal.
 *
 * @see https://www.phoenixopendata.com/dataset/fire-incidents
 */
export class PhoenixFirePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'phoenix-fire',
    name: 'Phoenix Fire Department',
    version: '1.0.0',
    description: 'Fire and EMS incidents from Phoenix Fire Department',
    coverage: {
      type: 'regional',
      center: PHOENIX_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Phoenix, AZ metropolitan area',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['fire', 'medical'],
    refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
  };

  private fireConfig: PhoenixFirePluginConfig;

  constructor(config?: PhoenixFirePluginConfig) {
    super(config);
    this.fireConfig = {
      limit: 1000,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const cacheKey = this.generateCacheKey(options);

    // NOTE: Phoenix Open Data no longer provides a Socrata API for fire/EMS data.
    // The data is only available as yearly CSV downloads, which is not suitable for real-time querying.
    // This plugin is kept for backwards compatibility but returns empty results.
    // See: https://www.phoenixopendata.com/dataset/calls-for-service-fire
    const warnings = [
      'Phoenix Fire data source unavailable: Phoenix Open Data has discontinued the Socrata API. ' +
      'Fire/EMS calls for service data is now only available as yearly CSV downloads, which cannot be queried in real-time.'
    ];

    return {
      alerts: [],
      fromCache: false,
      cacheKey,
      warnings,
    };
  }

  /**
   * Build the Socrata API URL for Phoenix fire data.
   */
  private buildApiUrl(
    location: { latitude: number; longitude: number },
    timeRange: { start: string; end: string },
    radiusMeters: number,
    limit?: number
  ): string {
    // Phoenix Fire incidents dataset
    const baseUrl = 'https://www.phoenixopendata.com/resource/m3af-pnrm.json';

    const params = new URLSearchParams();

    // Limit results
    params.set('$limit', String(limit ?? this.fireConfig.limit));

    // Order by most recent
    params.set('$order', 'incident_date DESC');

    // Build WHERE clause
    const whereClauses: string[] = [];

    // Time filter
    const startDate = timeRange.start.split('T')[0];
    const endDate = timeRange.end.split('T')[0];
    whereClauses.push(`incident_date >= '${startDate}'`);
    whereClauses.push(`incident_date <= '${endDate}'`);

    // Location filter using within_circle
    whereClauses.push(
      `within_circle(geocoded_column, ${location.latitude}, ${location.longitude}, ${radiusMeters})`
    );

    params.set('$where', whereClauses.join(' AND '));

    // Add app token if provided
    if (this.fireConfig.appToken) {
      params.set('$$app_token', this.fireConfig.appToken);
    }

    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Fetch incidents from the API.
   */
  private async fetchIncidents(url: string): Promise<PhoenixFireIncident[]> {
    return this.fetchJson<PhoenixFireIncident[]>(url);
  }

  /**
   * Transform a Phoenix Fire incident to our Alert format.
   */
  private transformIncident(incident: PhoenixFireIncident) {
    const callType = (incident.call_type_final ?? incident.call_type ?? 'UNKNOWN').toUpperCase();
    const { category, risk } = this.mapCallType(callType);

    // Parse coordinates
    const latitude = incident.latitude ? parseFloat(incident.latitude) : PHOENIX_CENTER.latitude;
    const longitude = incident.longitude
      ? parseFloat(incident.longitude)
      : PHOENIX_CENTER.longitude;

    // Build timestamp from incident_date and dispatch_time
    const incidentDate = incident.incident_date ?? new Date().toISOString().split('T')[0];
    const dispatchTime = incident.dispatch_time ?? '00:00:00';
    const issued = `${incidentDate}T${dispatchTime}`;

    // Determine if this is real-time (within last hour) or historical
    const issuedTime = new Date(issued).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const temporalType = issuedTime > oneHourAgo ? 'real-time' : 'historical';

    return this.createAlert({
      id: `phoenix-fire-${incident.incident_number}`,
      externalId: incident.incident_number,
      title: this.formatCallType(callType),
      description: this.buildDescription(incident),
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType,
      location: {
        point: { latitude, longitude },
        address: incident.address,
        city: incident.city ?? 'Phoenix',
        state: 'AZ',
        zipCode: incident.zip,
      },
      timestamps: {
        issued,
        eventStart: issued,
        eventEnd: incident.clear_time ? `${incidentDate}T${incident.clear_time}` : undefined,
      },
      metadata: {
        incidentNumber: incident.incident_number,
        callType,
        priority: incident.priority,
        station: incident.station,
        battalion: incident.battalion,
        arrivalTime: incident.arrival_time,
        clearTime: incident.clear_time,
      },
    });
  }

  /**
   * Map a call type to category and risk level.
   */
  private mapCallType(callType: string): { category: AlertCategory; risk: RiskLevel } {
    // Try exact match first
    if (CALL_TYPE_MAP[callType]) {
      return CALL_TYPE_MAP[callType];
    }

    // Try partial match
    for (const [key, value] of Object.entries(CALL_TYPE_MAP)) {
      if (callType.includes(key) || key.includes(callType)) {
        return value;
      }
    }

    // Default based on common keywords
    if (callType.includes('FIRE') || callType.includes('SMOKE') || callType.includes('BURN')) {
      return { category: 'fire', risk: 'high' };
    }

    if (
      callType.includes('MEDICAL') ||
      callType.includes('EMS') ||
      callType.includes('AMBULANCE')
    ) {
      return { category: 'medical', risk: 'moderate' };
    }

    // Default
    return { category: 'fire', risk: 'moderate' };
  }

  /**
   * Format call type for display.
   */
  private formatCallType(callType: string): string {
    return callType
      .toLowerCase()
      .replace(/_/g, ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Build description from incident data.
   */
  private buildDescription(incident: PhoenixFireIncident): string {
    const parts: string[] = [];

    const callType = incident.call_type_final ?? incident.call_type;
    if (callType) {
      parts.push(`Type: ${this.formatCallType(callType)}`);
    }

    if (incident.address) {
      parts.push(`Location: ${incident.address}`);
    }

    if (incident.priority) {
      parts.push(`Priority: ${incident.priority}`);
    }

    if (incident.station) {
      parts.push(`Station: ${incident.station}`);
    }

    return parts.join('\n');
  }
}
