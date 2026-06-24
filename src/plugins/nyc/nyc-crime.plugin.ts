import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * NYPD complaint record (GeoJSON properties) from NYC Open Data.
 */
interface NYPDComplaint {
  cmplnt_num: string;
  cmplnt_fr_dt?: string; // floating timestamp "YYYY-MM-DDT00:00:00"
  cmplnt_fr_tm?: string; // "HH:MM:SS"
  cmplnt_to_dt?: string;
  ofns_desc?: string;
  pd_desc?: string;
  law_cat_cd?: string; // FELONY | MISDEMEANOR | VIOLATION
  crm_atpt_cptd_cd?: string; // COMPLETED | ATTEMPTED
  boro_nm?: string;
  loc_of_occur_desc?: string; // INSIDE | OUTSIDE | FRONT OF ...
  prem_typ_desc?: string;
  addr_pct_cd?: string;
  patrol_boro?: string;
  transit_district?: string;
  station_name?: string;
  parks_nm?: string;
  latitude?: string;
  longitude?: string;
}

/**
 * GeoJSON FeatureCollection from the Socrata endpoint.
 */
interface SocrataGeoJSONResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: NYPDComplaint;
    geometry: {
      type: 'Point';
      coordinates: [number, number]; // [lng, lat]
    } | null;
  }>;
}

/**
 * NYC Crime plugin configuration.
 */
export interface NYCCrimePluginConfig extends BasePluginConfig {
  /** Minimum risk level to include (filters out low-level offenses). Default: undefined (all) */
  minRiskLevel?: RiskLevel;
  /** Maximum records to fetch per request. Default: 1000 */
  limit?: number;
}

/**
 * New York City center coordinates (Midtown/Manhattan).
 */
const NYC_CENTER = {
  latitude: 40.73,
  longitude: -73.99,
};

/**
 * Coverage radius in meters (~30km covers all five boroughs, the Financial
 * District and Hudson Yards in Manhattan, and JFK in Queens ~21km SE).
 */
const COVERAGE_RADIUS_METERS = 30_000;

/**
 * NYPD offense (or keyword) to risk level mapping. Applied on top of the
 * law-category baseline; the higher of the two wins.
 */
const OFFENSE_RISK_MAP: Record<string, RiskLevel> = {
  MURDER: 'extreme',
  'MURDER & NON-NEGL. MANSLAUGHTER': 'extreme',
  HOMICIDE: 'extreme',
  KIDNAPPING: 'severe',
  'KIDNAPPING & RELATED OFFENSES': 'severe',
  ROBBERY: 'severe',
  'FELONY ASSAULT': 'severe',
  RAPE: 'severe',
  'SEX CRIMES': 'severe',
  ARSON: 'severe',
  BURGLARY: 'high',
  'GRAND LARCENY': 'high',
  'GRAND LARCENY OF MOTOR VEHICLE': 'high',
  'ASSAULT 3 & RELATED OFFENSES': 'high',
  'DANGEROUS WEAPONS': 'high',
  'DANGEROUS DRUGS': 'moderate',
  'PETIT LARCENY': 'moderate',
  'CRIMINAL MISCHIEF & RELATED OF': 'moderate',
  'OFFENSES AGAINST PUBLIC ADMINI': 'low',
  HARRASSMENT: 'low',
  'HARRASSMENT 2': 'low',
};

/**
 * Law category baseline risk.
 */
const LAW_CATEGORY_RISK: Record<string, RiskLevel> = {
  FELONY: 'high',
  MISDEMEANOR: 'moderate',
  VIOLATION: 'low',
};

/**
 * Plugin that fetches crime complaints from the New York City Police
 * Department via NYC Open Data (Socrata).
 *
 * Covers all five boroughs, including the Financial District and Hudson Yards
 * (Manhattan) and JFK (Queens). Includes precise lat/lng.
 *
 * NOTE: This dataset is the "Year To Date" complaint file, updated quarterly,
 * so the most recent complete quarter is the freshest data available — it is
 * not a real-time dispatch feed.
 *
 * @see https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Current-Year-To-Date-/5uac-w243
 */
export class NYCCrimePlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'nyc-crime',
    name: 'NYPD Complaint Data',
    version: '1.0.0',
    description: 'Felony, misdemeanor, and violation complaints from the NYPD',
    coverage: {
      type: 'regional',
      center: NYC_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'New York City — five boroughs incl. Financial District, Hudson Yards, JFK',
    },
    temporal: {
      supportsPast: true,
      supportsFuture: false,
      dataLagMinutes: 60 * 24 * 45, // ~quarterly publication
      freshnessDescription: 'Updated quarterly (most recent complete quarter)',
    },
    supportedTemporalTypes: ['historical'],
    supportedCategories: ['crime'],
    refreshIntervalMs: 24 * 60 * 60 * 1000, // 1 day
    defaultRadiusMeters: 2_000,
  };

  private crimeConfig: NYCCrimePluginConfig;

  constructor(config?: NYCCrimePluginConfig) {
    super(config);
    this.crimeConfig = {
      limit: 1000,
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
        () => this.fetchComplaints(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('NYC Crime fetch error:', error);
      throw error;
    }
  }

  /**
   * Fetch complaints from the NYC Open Data Socrata GeoJSON endpoint.
   *
   * Uses a server-side spatial filter (within_circle) clamped to the plugin
   * coverage radius, plus a date lower bound.
   */
  private async fetchComplaints(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const baseUrl = 'https://data.cityofnewyork.us/resource/5uac-w243.geojson';

    // Clamp the query radius to the plugin's coverage radius.
    const effectiveRadius = Math.min(radiusMeters, COVERAGE_RADIUS_METERS);

    const startDate = new Date(timeRange.start).toISOString().split('T')[0];
    const endDate = new Date(timeRange.end).toISOString().split('T')[0];

    const where = [
      `cmplnt_fr_dt >= '${startDate}T00:00:00'`,
      `cmplnt_fr_dt <= '${endDate}T23:59:59'`,
      `within_circle(lat_lon, ${location.latitude}, ${location.longitude}, ${Math.round(effectiveRadius)})`,
    ].join(' AND ');

    const params = new URLSearchParams({
      $where: where,
      $order: 'cmplnt_fr_dt DESC',
      $limit: String(this.crimeConfig.limit),
    });

    const url = `${baseUrl}?${params}`;

    try {
      const response = await this.fetchJson<SocrataGeoJSONResponse>(url);

      if (!response.features || !Array.isArray(response.features)) {
        return [];
      }

      const alerts = response.features
        .filter((f) => {
          if (!f.geometry?.coordinates) return false;

          if (this.crimeConfig.minRiskLevel) {
            const riskLevel = this.mapToRisk(f.properties);
            if (!this.meetsMinRisk(riskLevel, this.crimeConfig.minRiskLevel)) {
              return false;
            }
          }

          return true;
        })
        .map((f) => this.transformComplaint(f.properties, f.geometry!.coordinates));

      return alerts;
    } catch (error) {
      warnings.push(
        `Failed to fetch NYPD complaints: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Transform an NYPD complaint to our Alert format.
   */
  private transformComplaint(complaint: NYPDComplaint, coordinates: [number, number]) {
    const [longitude, latitude] = coordinates;
    const riskLevel = this.mapToRisk(complaint);
    const occurred = this.parseOccurredAt(complaint);

    return this.createAlert({
      id: `nyc-crime-${complaint.cmplnt_num}`,
      externalId: complaint.cmplnt_num,
      title: this.formatOffense(complaint.ofns_desc, complaint.law_cat_cd),
      description: this.buildDescription(complaint),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'crime',
      temporalType: 'historical',
      location: {
        point: { latitude, longitude },
        address: complaint.prem_typ_desc,
        city: this.boroToCity(complaint.boro_nm),
        state: 'NY',
      },
      timestamps: {
        issued: occurred,
        eventStart: occurred,
      },
      metadata: {
        complaintNumber: complaint.cmplnt_num,
        offense: complaint.ofns_desc,
        pdDescription: complaint.pd_desc,
        lawCategory: complaint.law_cat_cd,
        completed: complaint.crm_atpt_cptd_cd,
        borough: complaint.boro_nm,
        locationOfOccurrence: complaint.loc_of_occur_desc,
        premisesType: complaint.prem_typ_desc,
        precinct: complaint.addr_pct_cd,
        transitDistrict: complaint.transit_district,
        stationName: complaint.station_name,
        parkName: complaint.parks_nm,
      },
    });
  }

  /**
   * Compute the risk level: the higher of the law-category baseline and the
   * offense-specific mapping.
   */
  private mapToRisk(complaint: NYPDComplaint): RiskLevel {
    const order: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'extreme'];

    const baseline = LAW_CATEGORY_RISK[(complaint.law_cat_cd ?? '').toUpperCase()] ?? 'low';

    const offense = (complaint.ofns_desc ?? '').toUpperCase().trim();
    let offenseRisk: RiskLevel | undefined = OFFENSE_RISK_MAP[offense];

    if (!offenseRisk) {
      if (offense.includes('MURDER') || offense.includes('HOMICIDE')) offenseRisk = 'extreme';
      else if (offense.includes('RAPE') || offense.includes('SEX')) offenseRisk = 'severe';
      else if (offense.includes('ROBBERY') || offense.includes('KIDNAP')) offenseRisk = 'severe';
      else if (offense.includes('FELONY ASSAULT') || offense.includes('ARSON')) offenseRisk = 'severe';
      else if (offense.includes('BURGLARY')) offenseRisk = 'high';
      else if (offense.includes('GRAND LARCENY')) offenseRisk = 'high';
      else if (offense.includes('WEAPON')) offenseRisk = 'high';
      else if (offense.includes('ASSAULT')) offenseRisk = 'high';
      else if (offense.includes('LARCENY') || offense.includes('MISCHIEF')) offenseRisk = 'moderate';
      else if (offense.includes('DRUG')) offenseRisk = 'moderate';
    }

    if (!offenseRisk) return baseline;
    return order.indexOf(offenseRisk) >= order.indexOf(baseline) ? offenseRisk : baseline;
  }

  /**
   * Check if a risk level meets the minimum threshold.
   */
  private meetsMinRisk(riskLevel: RiskLevel, minRisk: RiskLevel): boolean {
    const riskOrder: RiskLevel[] = ['low', 'moderate', 'high', 'severe', 'extreme'];
    return riskOrder.indexOf(riskLevel) >= riskOrder.indexOf(minRisk);
  }

  /**
   * Build an ISO timestamp from the complaint date and time.
   */
  private parseOccurredAt(complaint: NYPDComplaint): string {
    const date = (complaint.cmplnt_fr_dt ?? '').split('T')[0];
    if (!date) return new Date().toISOString();
    const time = complaint.cmplnt_fr_tm && /^\d{2}:\d{2}/.test(complaint.cmplnt_fr_tm)
      ? complaint.cmplnt_fr_tm
      : '00:00:00';
    const parsed = new Date(`${date}T${time}`);
    return Number.isNaN(parsed.getTime()) ? `${date}T00:00:00.000Z` : parsed.toISOString();
  }

  /**
   * Format offense for display.
   */
  private formatOffense(offense?: string, lawCat?: string): string {
    if (!offense) return lawCat ? this.titleCase(lawCat) : 'Crime Complaint';
    return this.titleCase(offense);
  }

  private titleCase(text: string): string {
    return text
      .split(/[\s/&]+/)
      .filter(Boolean)
      .map((word) => (word.length <= 2 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
      .join(' ')
      .trim();
  }

  /**
   * Map an NYPD borough name to a city label.
   */
  private boroToCity(boro?: string): string {
    const map: Record<string, string> = {
      MANHATTAN: 'Manhattan',
      BROOKLYN: 'Brooklyn',
      QUEENS: 'Queens',
      BRONX: 'Bronx',
      'STATEN ISLAND': 'Staten Island',
    };
    return map[(boro ?? '').toUpperCase()] ?? 'New York';
  }

  /**
   * Build description from complaint data.
   */
  private buildDescription(complaint: NYPDComplaint): string {
    const parts: string[] = [];

    if (complaint.ofns_desc) parts.push(`Offense: ${complaint.ofns_desc}`);
    if (complaint.pd_desc && complaint.pd_desc !== complaint.ofns_desc) {
      parts.push(`Detail: ${complaint.pd_desc}`);
    }
    if (complaint.law_cat_cd) parts.push(`Category: ${complaint.law_cat_cd}`);
    if (complaint.crm_atpt_cptd_cd) parts.push(`Status: ${complaint.crm_atpt_cptd_cd}`);
    if (complaint.prem_typ_desc) parts.push(`Premises: ${complaint.prem_typ_desc}`);
    if (complaint.loc_of_occur_desc) parts.push(`Location: ${complaint.loc_of_occur_desc}`);
    if (complaint.boro_nm) parts.push(`Borough: ${complaint.boro_nm}`);
    if (complaint.station_name) parts.push(`Transit: ${complaint.station_name}`);
    if (complaint.cmplnt_fr_dt) {
      parts.push(`Occurred: ${complaint.cmplnt_fr_dt.split('T')[0]} ${complaint.cmplnt_fr_tm ?? ''}`.trim());
    }

    return parts.join('\n');
  }
}
