import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * NWS Alert response structure.
 */
interface NWSAlertResponse {
  '@context'?: unknown;
  type: 'FeatureCollection';
  features: NWSAlertFeature[];
}

interface NWSAlertFeature {
  id: string;
  type: 'Feature';
  geometry: {
    type: string;
    coordinates: number[] | number[][] | number[][][];
  } | null;
  properties: NWSAlertProperties;
}

interface NWSAlertProperties {
  id: string;
  areaDesc: string;
  geocode: {
    SAME?: string[];
    UGC?: string[];
  };
  affectedZones: string[];
  references: unknown[];
  sent: string;
  effective: string;
  onset?: string;
  expires: string;
  ends?: string;
  status: 'Actual' | 'Exercise' | 'System' | 'Test' | 'Draft';
  messageType: 'Alert' | 'Update' | 'Cancel' | 'Ack' | 'Error';
  category: string;
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  certainty: 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown';
  urgency: 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';
  event: string;
  sender: string;
  senderName: string;
  headline?: string;
  description?: string;
  instruction?: string;
  response: string;
  parameters: Record<string, string[]>;
}

/**
 * NWS Weather plugin configuration.
 */
export interface NWSWeatherPluginConfig extends BasePluginConfig {
  /** Only include actual alerts (not tests/exercises). Default: true */
  actualOnly?: boolean;
  /** Filter by alert status. Default: ['Actual'] */
  status?: ('Actual' | 'Exercise' | 'System' | 'Test' | 'Draft')[];
}

/**
 * Plugin that fetches weather alerts from the National Weather Service API.
 *
 * This is a global plugin that covers all US locations.
 * The NWS API is free and requires no API key.
 *
 * @see https://www.weather.gov/documentation/services-web-api
 */
export class NWSWeatherPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'nws-weather',
    name: 'National Weather Service',
    version: '1.0.0',
    description: 'Weather alerts from the National Weather Service (US)',
    coverage: {
      type: 'global',
      description: 'United States and territories',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: true,
      dataLagMinutes: 5,
      futureLookaheadMinutes: 10080, // 7 days
      freshnessDescription: 'Near real-time, alerts up to 7 days ahead',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['weather'],
    refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
  };

  private nwsConfig: NWSWeatherPluginConfig;

  constructor(config?: NWSWeatherPluginConfig) {
    super(config);
    this.nwsConfig = {
      actualOnly: true,
      status: ['Actual'],
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location } = options;
    const cacheKey = this.generateCacheKey(options);

    // Build NWS API URL with point coordinates
    const url = `https://api.weather.gov/alerts/active?point=${location.latitude},${location.longitude}`;

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchJson<NWSAlertResponse>(url),
        this.config.cacheTtlMs
      );

      const alerts = this.transformAlerts(data, location);

      return {
        alerts,
        fromCache,
        cacheKey,
      };
    } catch (error) {
      // NWS API might return 404 for locations outside US
      if (error instanceof Error && error.message.includes('404')) {
        return this.emptyResult();
      }
      throw error;
    }
  }

  /**
   * Transform NWS alert features to our Alert format.
   */
  private transformAlerts(
    response: NWSAlertResponse,
    queryLocation: { latitude: number; longitude: number }
  ) {
    return response.features
      .filter((feature) => this.shouldIncludeAlert(feature.properties))
      .map((feature) => this.transformAlert(feature, queryLocation));
  }

  /**
   * Check if an alert should be included based on config.
   */
  private shouldIncludeAlert(props: NWSAlertProperties): boolean {
    // Filter by status
    if (this.nwsConfig.status && !this.nwsConfig.status.includes(props.status)) {
      return false;
    }

    // Filter out cancelled alerts
    if (props.messageType === 'Cancel') {
      return false;
    }

    return true;
  }

  /**
   * Transform a single NWS alert to our format.
   */
  private transformAlert(
    feature: NWSAlertFeature,
    queryLocation: { latitude: number; longitude: number }
  ) {
    const props = feature.properties;

    // Extract location from geometry if available, otherwise use query location
    const location = this.extractLocation(feature, queryLocation);

    // Map NWS severity to our risk level
    const riskLevel = this.mapSeverityToRiskLevel(props.severity);

    // Determine temporal type based on urgency
    const temporalType = props.urgency === 'Past' ? 'historical' : 'real-time';

    return this.createAlert({
      id: `nws-${props.id}`,
      externalId: props.id,
      title: props.headline ?? props.event,
      description: this.buildDescription(props),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'weather',
      temporalType,
      location: {
        point: location,
        address: props.areaDesc,
      },
      timestamps: {
        issued: props.sent,
        eventStart: props.onset ?? props.effective,
        eventEnd: props.ends,
        expires: props.expires,
      },
      url: `https://alerts.weather.gov/cap/wwacapget.php?x=${props.id}`,
      metadata: {
        event: props.event,
        severity: props.severity,
        certainty: props.certainty,
        urgency: props.urgency,
        instruction: props.instruction,
        sender: props.senderName,
        affectedZones: props.affectedZones,
      },
    });
  }

  /**
   * Extract location from feature geometry.
   */
  private extractLocation(
    feature: NWSAlertFeature,
    fallback: { latitude: number; longitude: number }
  ): { latitude: number; longitude: number } {
    if (!feature.geometry) {
      return fallback;
    }

    const coords = feature.geometry.coordinates;

    // Handle Point geometry
    if (feature.geometry.type === 'Point' && Array.isArray(coords) && coords.length >= 2) {
      return { latitude: coords[1] as number, longitude: coords[0] as number };
    }

    // Handle Polygon - use centroid of first ring
    if (feature.geometry.type === 'Polygon' && Array.isArray(coords[0])) {
      const ring = coords[0] as number[][];
      if (ring.length > 0) {
        let sumLat = 0;
        let sumLon = 0;
        for (const point of ring) {
          sumLon += point[0];
          sumLat += point[1];
        }
        return {
          latitude: sumLat / ring.length,
          longitude: sumLon / ring.length,
        };
      }
    }

    return fallback;
  }

  /**
   * Map NWS severity to our risk level.
   */
  private mapSeverityToRiskLevel(severity: NWSAlertProperties['severity']): RiskLevel {
    const map: Record<NWSAlertProperties['severity'], RiskLevel> = {
      Extreme: 'extreme',
      Severe: 'severe',
      Moderate: 'high',
      Minor: 'moderate',
      Unknown: 'low',
    };
    return map[severity] ?? 'moderate';
  }

  /**
   * Build a description from NWS properties.
   */
  private buildDescription(props: NWSAlertProperties): string {
    const parts: string[] = [];

    if (props.description) {
      parts.push(props.description);
    }

    if (props.instruction) {
      parts.push(`\n\nInstructions: ${props.instruction}`);
    }

    return parts.join('') || props.event;
  }
}
