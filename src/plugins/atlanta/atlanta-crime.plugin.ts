import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';
import { fetchArcGisFeatures, envelopeForRadius } from '../../utils/arcgis';

/**
 * Atlanta Police Department crime incident (NIBRS) from the
 * OpenDataWebsite_Crime_view hosted ArcGIS feature service.
 */
interface AtlantaCrimeIncident {
  OBJECTID: number;
  IncidentNumber: string;
  ReportNumber?: string;
  FireArmInvolved?: string; // "yes" | "no"
  ReportDate?: number; // epoch ms
  OccurredFromDate?: number; // epoch ms
  OccurredToDate?: number; // epoch ms
  Part?: string; // "Part I" | "Part II"
  Crime_Against?: string; // "Person" | "Property" | "Society"
  NibrsUcrCode?: string;
  NIBRS_Offense?: string;
  NIBRS_Bucket?: string;
  Vic_Count?: number | null;
  StreetAddress?: string;
  LocationType?: string;
  Longitude?: number;
  Latitude?: number;
  Zone?: string;
  BEAT?: string;
  NPU?: string;
  NhoodName?: string;
  GAFamilyViolenceIndicator?: string; // "YES" | "NO"
}

/**
 * ArcGIS GeoJSON response.
 */
interface ArcGISGeoJSONResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: AtlantaCrimeIncident;
    geometry: {
      type: 'Point';
      coordinates: [number, number]; // [lng, lat]
    } | null;
  }>;
}

/**
 * Atlanta Crime plugin configuration.
 */
export interface AtlantaCrimePluginConfig extends BasePluginConfig {
  /** Include family violence incidents. Default: true */
  includeFamilyViolence?: boolean;
  /** Minimum risk level to include (filters out low-level offenses). Default: undefined (all) */
  minRiskLevel?: RiskLevel;
  /**
   * Records requested per page. Default: 1000 (layer maxRecordCount is 2000).
   * @deprecated Prefer `pageSize`; `limit` is honoured as the page size and no
   * longer caps the overall result.
   */
  limit?: number;
  /** Records requested per page. Default: 1000. */
  pageSize?: number;
  /** Ceiling across all pages for one query. Default: 5000. */
  maxRecords?: number;
}

/**
 * Atlanta, GA center coordinates (downtown).
 */
const ATLANTA_CENTER = {
  latitude: 33.749,
  longitude: -84.388,
};

/**
 * Coverage radius in meters (~40km covers the Atlanta metro, including
 * Hartsfield-Jackson Atlanta International Airport ~13km south and the
 * Delta Air Lines main campus).
 */
const COVERAGE_RADIUS_METERS = 40_000;

/**
 * NIBRS offense (or keyword) to risk level mapping.
 */
const OFFENSE_RISK_MAP: Record<string, RiskLevel> = {
  // Violent / against persons
  MURDER: 'extreme',
  HOMICIDE: 'extreme',
  MANSLAUGHTER: 'extreme',
  RAPE: 'severe',
  SODOMY: 'severe',
  'SEXUAL ASSAULT': 'severe',
  'AGGRAVATED ASSAULT': 'severe',
  ROBBERY: 'severe',
  KIDNAPPING: 'severe',
  'KIDNAPPING/ABDUCTION': 'severe',
  'SIMPLE ASSAULT': 'high',
  'INTIMIDATION': 'moderate',

  // Property
  ARSON: 'severe',
  BURGLARY: 'high',
  'BURGLARY/BREAKING & ENTERING': 'high',
  'MOTOR VEHICLE THEFT': 'high',
  'THEFT FROM MOTOR VEHICLE': 'moderate',
  'THEFT OF MOTOR VEHICLE PARTS OR ACCESSORIES': 'moderate',
  'STOLEN PROPERTY OFFENSES': 'moderate',
  'SHOPLIFTING': 'low',
  'ALL OTHER LARCENY': 'moderate',
  'DESTRUCTION/DAMAGE/VANDALISM OF PROPERTY': 'moderate',
  'COUNTERFEITING/FORGERY': 'low',
  'FRAUD': 'low',

  // Weapons
  'WEAPON LAW VIOLATIONS': 'high',

  // Society / other
  'DRUG/NARCOTIC VIOLATIONS': 'moderate',
  'DRUG EQUIPMENT VIOLATIONS': 'low',
  'TRESPASS OF REAL PROPERTY': 'low',
  'DISORDERLY CONDUCT': 'low',
  'ALL OTHER OFFENSES': 'low',
};

/**
 * Plugin that fetches crime incidents from the Atlanta Police Department.
 *
 * Uses the APD Open Data hosted ArcGIS feature layer (NIBRS incidents),
 * which is updated hourly and includes precise lat/lng coordinates.
 *
 * @see https://opendata.atlantapd.org/
 * @see https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/OpenDataWebsite_Crime_view/FeatureServer/0
 */
export class AtlantaCrimePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'atlanta-crime',
    name: 'Atlanta Police Department Crime Reports',
    version: '1.0.0',
    description: 'NIBRS crime incidents from the Atlanta Police Department',
    coverage: {
      type: 'regional',
      center: ATLANTA_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Atlanta, GA metropolitan area (incl. Hartsfield-Jackson airport)',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 60, // hourly updates
      freshnessDescription: 'Updated hourly',
    },
    supportedTemporalTypes: ['historical', 'real-time'],
    supportedCategories: ['crime'],
    refreshIntervalMs: 60 * 60 * 1000, // 1 hour
    defaultRadiusMeters: 10_000,
  };

  private crimeConfig: AtlantaCrimePluginConfig;

  constructor(config?: AtlantaCrimePluginConfig) {
    super(config);
    this.crimeConfig = {
      includeFamilyViolence: true,
      pageSize: config?.pageSize ?? config?.limit ?? 1000,
      maxRecords: 5000,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters, timeRange } = options;
    const cacheKey = this.generateCacheKey(options);

    try {
      // Warnings are cached with the alerts. Previously they were pushed into an
      // array captured by the cached fetcher, so a cache hit silently dropped them.
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchCrimeReports(location, radiusMeters, timeRange),
        this.config.cacheTtlMs
      );

      return {
        alerts: data.alerts,
        fromCache,
        cacheKey,
        warnings: data.warnings.length > 0 ? data.warnings : undefined,
      };
    } catch (error) {
      console.error('Atlanta Crime fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch crime incidents from the APD ArcGIS feature service.
   */
  private async fetchCrimeReports(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string }
  ): Promise<{ alerts: ReturnType<AtlantaCrimePlugin['transformIncident']>[]; warnings: string[] }> {
    const warnings: string[] = [];
    const baseUrl =
      'https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/OpenDataWebsite_Crime_view/FeatureServer/0/query';

    // This hosted layer accepts TIMESTAMP literals for date fields (epoch-ms
    // numeric comparisons are rejected).
    const startTs = this.toTimestampLiteral(timeRange.start);
    const endTs = this.toTimestampLiteral(timeRange.end);

    const params = new URLSearchParams({
      where: `OccurredFromDate >= TIMESTAMP '${startTs}' AND OccurredFromDate <= TIMESTAMP '${endTs}'`,
      outFields: '*',
      f: 'geojson',
      outSR: '4326',
      orderByFields: 'OccurredFromDate DESC',
      // Previously unbounded: the whole city was fetched, then the newest N kept.
      geometry: envelopeForRadius(location.latitude, location.longitude, radiusMeters),
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
    });

    try {
      const { features, truncated } = await fetchArcGisFeatures<ArcGISGeoJSONResponse['features'][number]>({
        baseUrl,
        params,
        pageSize: this.crimeConfig.pageSize!,
        maxRecords: this.crimeConfig.maxRecords!,
        fetchJson: (url) => this.fetchJson(url),
      });

      if (truncated) {
        warnings.push(
          `Atlanta PD returned more than ${this.crimeConfig.maxRecords} incidents for this window; ` +
            `only the ${this.crimeConfig.maxRecords} most recent were read. Narrow the time range or radius for complete results.`
        );
      }

      const filtered = features.filter((f) => {
        if (!f.geometry?.coordinates) return false;
        const [lng, lat] = f.geometry.coordinates;
        if (typeof lat !== 'number' || typeof lng !== 'number') return false;

        // Filter by query radius
        const distance = this.calculateDistance(location.latitude, location.longitude, lat, lng);
        if (distance > radiusMeters) return false;

        const props = f.properties;

        // Filter family violence if configured
        if (!this.crimeConfig.includeFamilyViolence && props.GAFamilyViolenceIndicator === 'YES') {
          return false;
        }

        // Filter by minimum risk level if configured
        if (this.crimeConfig.minRiskLevel) {
          const riskLevel = this.mapOffenseToRisk(props);
          if (!this.meetsMinRisk(riskLevel, this.crimeConfig.minRiskLevel)) {
            return false;
          }
        }

        return true;
      });

      const alerts = filtered.map((f) => this.transformIncident(f.properties, f.geometry!.coordinates));
      return { alerts, warnings };
    } catch (error) {
      warnings.push(
        `Failed to fetch Atlanta crime reports: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return { alerts: [], warnings };
    }
  }

  /**
   * Transform an APD crime incident to our Alert format.
   */
  private transformIncident(incident: AtlantaCrimeIncident, coordinates: [number, number]) {
    const [longitude, latitude] = coordinates;
    const riskLevel = this.mapOffenseToRisk(incident);

    const occurred = incident.OccurredFromDate ?? incident.ReportDate ?? Date.now();
    const issued = incident.ReportDate ?? occurred;

    // Determine if recent (within last 24 hours)
    const isRecent = Date.now() - occurred < 24 * 60 * 60 * 1000;
    const temporalType = isRecent ? 'real-time' : 'historical';

    return this.createAlert({
      id: `atlanta-crime-${incident.IncidentNumber}`,
      externalId: incident.IncidentNumber,
      title: this.formatOffense(incident.NIBRS_Offense),
      description: this.buildDescription(incident),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'crime',
      temporalType,
      location: {
        point: { latitude, longitude },
        address: incident.StreetAddress,
        city: 'Atlanta',
        state: 'GA',
      },
      timestamps: {
        issued: new Date(issued).toISOString(),
        eventStart: new Date(occurred).toISOString(),
        eventEnd: incident.OccurredToDate ? new Date(incident.OccurredToDate).toISOString() : undefined,
      },
      metadata: {
        incidentNumber: incident.IncidentNumber,
        reportNumber: incident.ReportNumber,
        offense: incident.NIBRS_Offense,
        ucrCode: incident.NibrsUcrCode,
        part: incident.Part,
        crimeAgainst: incident.Crime_Against,
        firearmInvolved: incident.FireArmInvolved === 'yes',
        familyViolence: incident.GAFamilyViolenceIndicator === 'YES',
        locationType: incident.LocationType,
        zone: incident.Zone,
        beat: incident.BEAT,
        npu: incident.NPU,
        neighborhood: incident.NhoodName,
        victimCount: incident.Vic_Count ?? undefined,
      },
    });
  }

  /**
   * Map a NIBRS offense to a risk level.
   *
   * Firearm involvement bumps the risk one level (capped at extreme).
   */
  private mapOffenseToRisk(incident: AtlantaCrimeIncident): RiskLevel {
    const offense = (incident.NIBRS_Offense ?? '').toUpperCase().trim();
    let risk: RiskLevel | undefined = OFFENSE_RISK_MAP[offense];

    if (!risk) {
      // Partial keyword matches
      if (offense.includes('MURDER') || offense.includes('HOMICIDE') || offense.includes('MANSLAUGHTER')) {
        risk = 'extreme';
      } else if (offense.includes('RAPE') || offense.includes('SEXUAL') || offense.includes('SODOMY')) {
        risk = 'severe';
      } else if (offense.includes('AGGRAVATED') || offense.includes('ROBBERY') || offense.includes('KIDNAP')) {
        risk = 'severe';
      } else if (offense.includes('ARSON')) {
        risk = 'severe';
      } else if (offense.includes('ASSAULT')) {
        risk = 'high';
      } else if (offense.includes('BURGLARY') || offense.includes('BREAKING')) {
        risk = 'high';
      } else if (offense.includes('MOTOR VEHICLE THEFT')) {
        risk = 'high';
      } else if (offense.includes('WEAPON')) {
        risk = 'high';
      } else if (offense.includes('THEFT') || offense.includes('LARCENY') || offense.includes('VANDALISM')) {
        risk = 'moderate';
      } else if (offense.includes('DRUG') || offense.includes('NARCOTIC')) {
        risk = 'moderate';
      } else {
        // Fall back on the NIBRS "Crime Against" grouping
        const against = (incident.Crime_Against ?? '').toUpperCase();
        if (against === 'PERSON') risk = 'high';
        else if (against === 'PROPERTY') risk = 'moderate';
        else risk = 'low';
      }
    }

    // Firearm involvement escalates severity
    if (incident.FireArmInvolved === 'yes') {
      risk = this.escalate(risk);
    }

    return risk;
  }

  /**
   * Escalate a risk level by one step (capped at extreme).
   */
  private escalate(level: RiskLevel): RiskLevel {
    const order: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'extreme'];
    const idx = order.indexOf(level);
    return order[Math.min(idx + 1, order.length - 1)];
  }

  /**
   * Check if a risk level meets the minimum threshold.
   */
  private meetsMinRisk(riskLevel: RiskLevel, minRisk: RiskLevel): boolean {
    const riskOrder: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'extreme'];
    return riskOrder.indexOf(riskLevel) >= riskOrder.indexOf(minRisk);
  }

  /**
   * Format offense type for display (Title Case).
   */
  private formatOffense(offense?: string): string {
    if (!offense) return 'Crime Incident';
    return offense
      .split(/[\s/]+/)
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
  private buildDescription(incident: AtlantaCrimeIncident): string {
    const parts: string[] = [];

    if (incident.NIBRS_Offense) {
      parts.push(`Offense: ${incident.NIBRS_Offense}`);
    }
    if (incident.Crime_Against) {
      parts.push(`Crime Against: ${incident.Crime_Against}`);
    }
    if (incident.StreetAddress) {
      parts.push(`Address: ${incident.StreetAddress}`);
    }
    if (incident.LocationType) {
      parts.push(`Location Type: ${incident.LocationType}`);
    }
    if (incident.FireArmInvolved === 'yes') {
      parts.push('Firearm Involved: Yes');
    }
    if (incident.GAFamilyViolenceIndicator === 'YES') {
      parts.push('Family Violence: Yes');
    }
    if (incident.Zone) {
      parts.push(`Zone: ${incident.Zone}${incident.BEAT ? ` (Beat ${incident.BEAT})` : ''}`);
    }
    if (incident.NhoodName) {
      parts.push(`Neighborhood: ${incident.NhoodName}`);
    }
    if (incident.OccurredFromDate) {
      parts.push(`Occurred: ${new Date(incident.OccurredFromDate).toLocaleString()}`);
    }

    return parts.join('\n');
  }

  /**
   * Convert an ISO timestamp to an ArcGIS TIMESTAMP literal (UTC, no 'Z').
   * Format: "YYYY-MM-DD HH:MM:SS"
   */
  private toTimestampLiteral(iso: string): string {
    const d = new Date(iso);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
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

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}
