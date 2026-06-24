import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * Major US airports with coordinates, keyed by IATA code. Used to (a) decide
 * which airports are near a query location and (b) place the resulting alert.
 */
const AIRPORTS: Record<string, { name: string; lat: number; lng: number; city: string; state: string }> = {
  ATL: { name: 'Hartsfield-Jackson Atlanta Intl', lat: 33.6407, lng: -84.4277, city: 'Atlanta', state: 'GA' },
  JFK: { name: 'John F. Kennedy Intl', lat: 40.6413, lng: -73.7781, city: 'Queens', state: 'NY' },
  LGA: { name: 'LaGuardia', lat: 40.7769, lng: -73.874, city: 'Queens', state: 'NY' },
  EWR: { name: 'Newark Liberty Intl', lat: 40.6895, lng: -74.1745, city: 'Newark', state: 'NJ' },
  LAX: { name: 'Los Angeles Intl', lat: 33.9416, lng: -118.4085, city: 'Los Angeles', state: 'CA' },
  ORD: { name: "Chicago O'Hare Intl", lat: 41.9742, lng: -87.9073, city: 'Chicago', state: 'IL' },
  MDW: { name: 'Chicago Midway Intl', lat: 41.7868, lng: -87.7522, city: 'Chicago', state: 'IL' },
  DFW: { name: 'Dallas/Fort Worth Intl', lat: 32.8998, lng: -97.0403, city: 'Dallas', state: 'TX' },
  DEN: { name: 'Denver Intl', lat: 39.8561, lng: -104.6737, city: 'Denver', state: 'CO' },
  SFO: { name: 'San Francisco Intl', lat: 37.6213, lng: -122.379, city: 'San Francisco', state: 'CA' },
  SEA: { name: 'Seattle-Tacoma Intl', lat: 47.4502, lng: -122.3088, city: 'Seattle', state: 'WA' },
  LAS: { name: 'Harry Reid Intl', lat: 36.084, lng: -115.1537, city: 'Las Vegas', state: 'NV' },
  MCO: { name: 'Orlando Intl', lat: 28.4312, lng: -81.3081, city: 'Orlando', state: 'FL' },
  CLT: { name: 'Charlotte Douglas Intl', lat: 35.2144, lng: -80.9473, city: 'Charlotte', state: 'NC' },
  PHX: { name: 'Phoenix Sky Harbor Intl', lat: 33.4342, lng: -112.0116, city: 'Phoenix', state: 'AZ' },
  IAH: { name: 'Houston George Bush Intl', lat: 29.9902, lng: -95.3368, city: 'Houston', state: 'TX' },
  MIA: { name: 'Miami Intl', lat: 25.7959, lng: -80.287, city: 'Miami', state: 'FL' },
  BOS: { name: 'Boston Logan Intl', lat: 42.3656, lng: -71.0096, city: 'Boston', state: 'MA' },
  MSP: { name: 'Minneapolis-St. Paul Intl', lat: 44.8848, lng: -93.2223, city: 'Minneapolis', state: 'MN' },
  FLL: { name: 'Fort Lauderdale-Hollywood Intl', lat: 26.0742, lng: -80.1506, city: 'Fort Lauderdale', state: 'FL' },
  DTW: { name: 'Detroit Metro Wayne County', lat: 42.2162, lng: -83.3554, city: 'Detroit', state: 'MI' },
  PHL: { name: 'Philadelphia Intl', lat: 39.8744, lng: -75.2424, city: 'Philadelphia', state: 'PA' },
  BWI: { name: 'Baltimore/Washington Intl', lat: 39.1774, lng: -76.6684, city: 'Baltimore', state: 'MD' },
  SLC: { name: 'Salt Lake City Intl', lat: 40.7899, lng: -111.9791, city: 'Salt Lake City', state: 'UT' },
  SAN: { name: 'San Diego Intl', lat: 32.7338, lng: -117.1933, city: 'San Diego', state: 'CA' },
  IAD: { name: 'Washington Dulles Intl', lat: 38.9531, lng: -77.4565, city: 'Washington', state: 'DC' },
  DCA: { name: 'Ronald Reagan Washington National', lat: 38.8512, lng: -77.0402, city: 'Washington', state: 'DC' },
  TPA: { name: 'Tampa Intl', lat: 27.9755, lng: -82.5332, city: 'Tampa', state: 'FL' },
  PDX: { name: 'Portland Intl', lat: 45.5898, lng: -122.5951, city: 'Portland', state: 'OR' },
  AUS: { name: 'Austin-Bergstrom Intl', lat: 30.1975, lng: -97.6664, city: 'Austin', state: 'TX' },
  BNA: { name: 'Nashville Intl', lat: 36.1263, lng: -86.6774, city: 'Nashville', state: 'TN' },
  HNL: { name: 'Daniel K. Inouye Intl', lat: 21.3187, lng: -157.9225, city: 'Honolulu', state: 'HI' },
};

/**
 * Parse an FAA duration string (e.g. "1 hour and 24 minutes", "36 minutes")
 * into total minutes. Exported for testing.
 */
export function parseFaaDurationMinutes(text?: string): number | null {
  if (!text) return null;
  const hourMatch = text.match(/(\d+)\s*hour/i);
  const minMatch = text.match(/(\d+)\s*minute/i);
  if (!hourMatch && !minMatch) return null;
  const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
  const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
  return hours * 60 + mins;
}

/**
 * Normalize a parsed XML node that may be a single object or an array into an
 * array.
 */
function toArray<T>(node: T | T[] | undefined): T[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

interface FAADelayType {
  Name?: string;
  Ground_Stop_List?: { Program?: unknown };
  Ground_Delay_List?: { Ground_Delay?: unknown };
  Arrival_Departure_Delay_List?: { Delay?: unknown };
  Airport_Closure_List?: { Airport?: unknown };
}

interface FAAResponse {
  AIRPORT_STATUS_INFORMATION?: {
    Update_Time?: string;
    Delay_type?: FAADelayType | FAADelayType[];
  };
}

/**
 * FAA Airport Status plugin configuration.
 */
export interface FAAAirportStatusPluginConfig extends BasePluginConfig {
  /**
   * How close (meters) an airport must be to the query location to be
   * considered relevant. Airport disruptions have metro-wide impact, so this
   * defaults to 40km regardless of the (often smaller) query radius.
   */
  proximityMeters?: number;
  /** Restrict to a specific set of IATA codes (default: all known airports). */
  airportCodes?: string[];
}

/**
 * Plugin that reports operational disruptions (ground stops, ground delay
 * programs, arrival/departure delays, and closures) at major US airports from
 * the FAA's national airport status feed.
 *
 * The feed only lists airports currently experiencing a disruption, so this
 * plugin emits an alert only when a major airport near the query location
 * appears in the feed.
 *
 * @see https://nasstatus.faa.gov/
 */
export class FAAAirportStatusPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'faa-airport-status',
    name: 'FAA Airport Status',
    version: '1.0.0',
    description: 'Ground stops, ground delay programs, and closures at major US airports',
    coverage: {
      type: 'global',
      description: 'Major US airports (incl. ATL, JFK, LGA, EWR)',
    },
    temporal: {
      supportsPast: false,
      supportsFuture: false,
      dataLagMinutes: 5,
      freshnessDescription: 'Near real-time FAA national airport status',
    },
    supportedTemporalTypes: ['real-time'],
    supportedCategories: ['traffic'],
    refreshIntervalMs: 5 * 60 * 1000,
    defaultRadiusMeters: 40_000,
  };

  private airportConfig: FAAAirportStatusPluginConfig;

  constructor(config?: FAAAirportStatusPluginConfig) {
    super(config);
    this.airportConfig = {
      proximityMeters: 40_000,
      ...config,
    };
  }

  async fetchAlerts(options: PluginFetchOptions): Promise<PluginFetchResult> {
    const { location, radiusMeters } = options;
    const cacheKey = this.generateCacheKey(options);
    const warnings: string[] = [];

    try {
      const { data, fromCache } = await this.getCachedOrFetch(
        cacheKey,
        () => this.fetchStatus(location, radiusMeters, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('FAA Airport Status fetch error:', error);
      throw error;
    }
  }

  private async fetchStatus(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    warnings: string[]
  ) {
    // Which airports are near this query?
    const proximity = Math.max(radiusMeters, this.airportConfig.proximityMeters ?? 40_000);
    const codes = this.airportConfig.airportCodes ?? Object.keys(AIRPORTS);
    const nearby = new Set(
      codes.filter((code) => {
        const a = AIRPORTS[code];
        if (!a) return false;
        return this.calculateDistance(location.latitude, location.longitude, a.lat, a.lng) <= proximity;
      })
    );

    if (nearby.size === 0) return [];

    try {
      const res = await this.fetchXml<FAAResponse>('https://nasstatus.faa.gov/api/airport-status-information');
      const root = res.AIRPORT_STATUS_INFORMATION;
      if (!root) return [];

      const updateTime = root.Update_Time;
      const alerts = [];

      for (const delayType of toArray(root.Delay_type)) {
        // Ground stops
        for (const p of toArray<any>(delayType.Ground_Stop_List?.Program)) {
          const a = this.buildAirportAlert(p?.ARPT, nearby, 'Ground Stop', 'severe', updateTime, {
            reason: p?.Reason,
            endTime: p?.End_Time,
          });
          if (a) alerts.push(a);
        }
        // Ground delay programs
        for (const g of toArray<any>(delayType.Ground_Delay_List?.Ground_Delay)) {
          const avg = parseFaaDurationMinutes(g?.Avg);
          const risk: RiskLevel = avg !== null && avg >= 90 ? 'severe' : avg !== null && avg >= 45 ? 'high' : 'moderate';
          const a = this.buildAirportAlert(g?.ARPT, nearby, 'Ground Delay Program', risk, updateTime, {
            reason: g?.Reason,
            avgDelay: g?.Avg,
            maxDelay: g?.Max,
          });
          if (a) alerts.push(a);
        }
        // Arrival/departure delays
        for (const d of toArray<any>(delayType.Arrival_Departure_Delay_List?.Delay)) {
          const ad = d?.Arrival_Departure;
          const maxMin = parseFaaDurationMinutes(ad?.Max);
          const risk: RiskLevel = maxMin !== null && maxMin >= 60 ? 'high' : maxMin !== null && maxMin >= 30 ? 'moderate' : 'low';
          const a = this.buildAirportAlert(d?.ARPT, nearby, 'Arrival/Departure Delay', risk, updateTime, {
            reason: d?.Reason,
            delayType: ad?.['@_Type'],
            minDelay: ad?.Min,
            maxDelay: ad?.Max,
            trend: ad?.Trend,
          });
          if (a) alerts.push(a);
        }
        // Closures
        for (const c of toArray<any>(delayType.Airport_Closure_List?.Airport)) {
          const a = this.buildAirportAlert(c?.ARPT, nearby, 'Airport Closure', 'extreme', updateTime, {
            reason: c?.Reason,
            start: c?.Start,
            reopen: c?.Reopen,
          });
          if (a) alerts.push(a);
        }
      }

      return alerts;
    } catch (error) {
      warnings.push(
        `Failed to fetch FAA airport status: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  /**
   * Build an alert for an airport if it is one of the nearby airports.
   */
  private buildAirportAlert(
    code: string | undefined,
    nearby: Set<string>,
    kind: string,
    riskLevel: RiskLevel,
    updateTime: string | undefined,
    detail: Record<string, unknown>
  ) {
    if (!code || !nearby.has(code)) return null;
    const a = AIRPORTS[code];
    if (!a) return null;

    const issued = this.parseUpdateTime(updateTime);
    const descParts = [`${a.name} (${code}) — ${kind}`];
    for (const [k, v] of Object.entries(detail)) {
      if (v !== undefined && v !== null && v !== '') descParts.push(`${this.labelize(k)}: ${v}`);
    }

    return this.createAlert({
      id: `faa-${code}-${kind.replace(/[^a-z]/gi, '').toLowerCase()}`,
      externalId: `${code}-${kind}`,
      title: `${kind} at ${code}`,
      description: descParts.join('\n'),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'traffic',
      temporalType: 'real-time',
      location: {
        point: { latitude: a.lat, longitude: a.lng },
        address: a.name,
        city: a.city,
        state: a.state,
      },
      timestamps: {
        issued,
        eventStart: issued,
      },
      metadata: {
        airportCode: code,
        airportName: a.name,
        disruptionType: kind,
        ...detail,
      },
    });
  }

  /**
   * Parse the FAA Update_Time (e.g. "Wed Jun 24 01:00:50 2026 GMT") to ISO.
   */
  private parseUpdateTime(updateTime?: string): string {
    if (!updateTime) return new Date().toISOString();
    const parsed = new Date(updateTime);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }

  private labelize(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase())
      .trim();
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
