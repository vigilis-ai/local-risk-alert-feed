import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel, AlertCategory } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Pulsepoint incident structure.
 */
interface PulsepointIncident {
  ID: string;
  AgencyID: string;
  CallReceivedDateTime: string;
  IncidentTypeName: string;
  IncidentTypeCode: string;
  FullDisplayAddress: string;
  MedicalEmergencyDisplayAddress?: string;
  Latitude: string;
  Longitude: string;
  Unit?: PulsepointUnit[];
  Status?: {
    IncidentClosed?: boolean;
  };
}

interface PulsepointUnit {
  UnitID: string;
  Status: string;
  PulsePointDispatchStatus: string;
}

interface PulsepointResponse {
  incidents?: {
    active?: PulsepointIncident[];
    recent?: PulsepointIncident[];
  };
}

/**
 * Pulsepoint plugin configuration.
 */
export interface PulsepointPluginConfig extends BasePluginConfig {
  /**
   * Pulsepoint agency IDs to monitor.
   * For Phoenix area:
   * - FPHX (Phoenix Fire)
   * - FMES (Mesa Fire)
   * - FTEM (Tempe Fire)
   * - FGLN (Glendale Fire)
   * - FSCOT (Scottsdale Fire)
   */
  agencyIds?: string[];
  /** Include recently closed incidents. Default: false */
  includeRecent?: boolean;
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
 * Default Phoenix metro area agencies.
 */
const DEFAULT_PHOENIX_AGENCIES = ['FPHX', 'FMES', 'FTEM', 'FGLN', 'FSCOT'];

/**
 * Incident type to category and risk mappings.
 */
const INCIDENT_TYPE_MAP: Record<string, { category: AlertCategory; risk: RiskLevel }> = {
  // Fire incidents
  'STRUCTURE FIRE': { category: 'fire', risk: 'extreme' },
  'RESIDENTIAL FIRE': { category: 'fire', risk: 'extreme' },
  'COMMERCIAL FIRE': { category: 'fire', risk: 'extreme' },
  'INDUSTRIAL FIRE': { category: 'fire', risk: 'extreme' },
  'APARTMENT FIRE': { category: 'fire', risk: 'extreme' },
  'HIGHRISE FIRE': { category: 'fire', risk: 'extreme' },
  'VEHICLE FIRE': { category: 'fire', risk: 'high' },
  'BRUSH FIRE': { category: 'fire', risk: 'severe' },
  'WILDFIRE': { category: 'fire', risk: 'severe' },
  'GRASS FIRE': { category: 'fire', risk: 'high' },
  'DUMPSTER FIRE': { category: 'fire', risk: 'moderate' },
  'FIRE ALARM': { category: 'fire', risk: 'low' },
  'SMOKE INVESTIGATION': { category: 'fire', risk: 'moderate' },

  // Medical emergencies
  'CARDIAC ARREST': { category: 'medical', risk: 'severe' },
  'CARDIAC EMERGENCY': { category: 'medical', risk: 'severe' },
  'STROKE': { category: 'medical', risk: 'severe' },
  'CHEST PAIN': { category: 'medical', risk: 'high' },
  'DIFFICULTY BREATHING': { category: 'medical', risk: 'high' },
  'RESPIRATORY': { category: 'medical', risk: 'high' },
  'UNCONSCIOUS': { category: 'medical', risk: 'high' },
  'OVERDOSE': { category: 'medical', risk: 'high' },
  'MEDICAL EMERGENCY': { category: 'medical', risk: 'high' },
  'MEDICAL AID': { category: 'medical', risk: 'moderate' },
  'FALL': { category: 'medical', risk: 'moderate' },
  'INJURY': { category: 'medical', risk: 'moderate' },
  'DIABETIC': { category: 'medical', risk: 'high' },
  'SEIZURE': { category: 'medical', risk: 'high' },

  // Traffic/rescue
  'TRAFFIC COLLISION': { category: 'medical', risk: 'high' },
  'TRAFFIC ACCIDENT': { category: 'medical', risk: 'high' },
  'MVA': { category: 'medical', risk: 'high' },
  'EXTRICATION': { category: 'medical', risk: 'severe' },
  'RESCUE': { category: 'medical', risk: 'high' },
  'WATER RESCUE': { category: 'medical', risk: 'severe' },
  'SWIFT WATER RESCUE': { category: 'medical', risk: 'severe' },

  // Hazmat
  'HAZMAT': { category: 'fire', risk: 'severe' },
  'GAS LEAK': { category: 'fire', risk: 'high' },
  'NATURAL GAS LEAK': { category: 'fire', risk: 'high' },
  'CARBON MONOXIDE': { category: 'fire', risk: 'high' },
  'ELECTRICAL': { category: 'fire', risk: 'high' },
};

/**
 * Plugin that fetches real-time fire and EMS incidents from Pulsepoint.
 *
 * Pulsepoint provides real-time incident data from participating fire departments.
 *
 * @see https://www.pulsepoint.org
 */
export class PulsepointPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'pulsepoint',
    name: 'Pulsepoint Real-Time Incidents',
    version: '1.0.0',
    description: 'Real-time fire and EMS incidents from Pulsepoint',
    coverage: {
      type: 'regional',
      center: PHOENIX_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Phoenix, AZ metropolitan area (participating agencies)',
    },
    supportedTemporalTypes: ['real-time'],
    supportedCategories: ['fire', 'medical'],
    refreshIntervalMs: 60 * 1000, // 1 minute - real-time data
  };

  private pulsepointConfig: PulsepointPluginConfig;

  constructor(config?: PulsepointPluginConfig) {
    super(config);
    this.pulsepointConfig = {
      agencyIds: DEFAULT_PHOENIX_AGENCIES,
      includeRecent: false,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const cacheKey = this.generateCacheKey(options);

    // NOTE: Pulsepoint has changed their web interface to a React SPA.
    // The old JSON API endpoint (web.pulsepoint.org/DB/giba.php) no longer returns JSON data.
    // This plugin is kept for backwards compatibility but returns empty results.
    // See: https://web.pulsepoint.org
    const warnings = [
      'Pulsepoint data source unavailable: Pulsepoint has updated their web interface and the ' +
      'public JSON API is no longer accessible. Real-time fire/EMS incident data cannot be retrieved.'
    ];

    return {
      alerts: [],
      fromCache: false,
      cacheKey,
      warnings,
    };
  }

  /**
   * Fetch incidents from all configured agencies.
   */
  private async fetchAllAgencies(warnings: string[]) {
    const allAlerts: ReturnType<typeof this.transformIncident>[] = [];

    for (const agencyId of this.pulsepointConfig.agencyIds!) {
      try {
        const incidents = await this.fetchAgencyIncidents(agencyId);
        const alerts = incidents.map((incident) => this.transformIncident(incident, agencyId));
        allAlerts.push(...alerts);
      } catch (error) {
        warnings.push(
          `Failed to fetch from agency ${agencyId}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    return allAlerts;
  }

  /**
   * Fetch incidents from a single Pulsepoint agency.
   */
  private async fetchAgencyIncidents(agencyId: string): Promise<PulsepointIncident[]> {
    // Pulsepoint web API endpoint
    const url = `https://web.pulsepoint.org/DB/giba.php?agency_id=${agencyId}`;

    const response = await this.fetchJson<PulsepointResponse>(url);

    const incidents: PulsepointIncident[] = [];

    if (response.incidents?.active) {
      incidents.push(...response.incidents.active);
    }

    if (this.pulsepointConfig.includeRecent && response.incidents?.recent) {
      incidents.push(...response.incidents.recent);
    }

    return incidents;
  }

  /**
   * Transform a Pulsepoint incident to our Alert format.
   */
  private transformIncident(incident: PulsepointIncident, agencyId: string) {
    const incidentType = incident.IncidentTypeName.toUpperCase();
    const { category, risk } = this.mapIncidentType(incidentType);

    const latitude = parseFloat(incident.Latitude);
    const longitude = parseFloat(incident.Longitude);

    // Use call received time as the incident time
    const issued = incident.CallReceivedDateTime;

    // Build description with unit info
    const description = this.buildDescription(incident);

    return this.createAlert({
      id: `pulsepoint-${agencyId}-${incident.ID}`,
      externalId: incident.ID,
      title: this.formatIncidentType(incident.IncidentTypeName),
      description,
      riskLevel: risk,
      priority: this.riskLevelToPriority(risk),
      category,
      temporalType: 'real-time',
      location: {
        point: { latitude, longitude },
        address: incident.MedicalEmergencyDisplayAddress ?? incident.FullDisplayAddress,
      },
      timestamps: {
        issued,
        eventStart: issued,
      },
      metadata: {
        agencyId,
        incidentTypeCode: incident.IncidentTypeCode,
        units: incident.Unit?.map((u) => ({
          id: u.UnitID,
          status: u.PulsePointDispatchStatus,
        })),
        isClosed: incident.Status?.IncidentClosed ?? false,
      },
    });
  }

  /**
   * Map incident type to category and risk level.
   */
  private mapIncidentType(incidentType: string): { category: AlertCategory; risk: RiskLevel } {
    // Try exact match
    if (INCIDENT_TYPE_MAP[incidentType]) {
      return INCIDENT_TYPE_MAP[incidentType];
    }

    // Try partial match
    for (const [key, value] of Object.entries(INCIDENT_TYPE_MAP)) {
      if (incidentType.includes(key)) {
        return value;
      }
    }

    // Default based on keywords
    if (incidentType.includes('FIRE') || incidentType.includes('SMOKE') || incidentType.includes('BURN')) {
      return { category: 'fire', risk: 'high' };
    }

    if (incidentType.includes('MEDICAL') || incidentType.includes('EMS') || incidentType.includes('AMBULANCE')) {
      return { category: 'medical', risk: 'moderate' };
    }

    // Default to medical (most common)
    return { category: 'medical', risk: 'moderate' };
  }

  /**
   * Format incident type for display.
   */
  private formatIncidentType(incidentType: string): string {
    return incidentType
      .toLowerCase()
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Build description from incident data.
   */
  private buildDescription(incident: PulsepointIncident): string {
    const parts: string[] = [];

    parts.push(`Type: ${this.formatIncidentType(incident.IncidentTypeName)}`);

    if (incident.FullDisplayAddress) {
      parts.push(`Location: ${incident.FullDisplayAddress}`);
    }

    if (incident.Unit && incident.Unit.length > 0) {
      const unitList = incident.Unit.map((u) => `${u.UnitID} (${u.PulsePointDispatchStatus})`).join(', ');
      parts.push(`Responding Units: ${unitList}`);
    }

    if (incident.Status?.IncidentClosed) {
      parts.push('Status: Closed');
    } else {
      parts.push('Status: Active');
    }

    return parts.join('\n');
  }

  /**
   * Calculate distance between two points in meters.
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3; // Earth radius in meters
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
