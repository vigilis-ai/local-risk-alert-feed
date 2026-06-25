import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';

/**
 * WZDx (Work Zone Data Exchange) v4 feature from the NJDOT/NJIT feed.
 * @see https://smartworkzones.njit.edu/nj/wzdx
 */
interface WZDxFeature {
  id?: string;
  type: 'Feature';
  geometry: {
    type: 'MultiPoint' | 'LineString' | 'Point';
    coordinates: number[] | number[][]; // [lng,lat] | [[lng,lat],...]
  } | null;
  properties: {
    core_details?: {
      event_type?: string;
      data_source_id?: string;
      road_names?: string[];
      direction?: string;
      description?: string;
      update_date?: string;
    };
    start_date?: string;
    end_date?: string;
    vehicle_impact?: string;
    types_of_work?: Array<{ type_name?: string }>;
    beginning_cross_street?: string;
  };
}

interface WZDxFeed {
  type: 'FeatureCollection';
  feed_info?: { update_date?: string; version?: string };
  features: WZDxFeature[];
}

/**
 * NJ Work Zones plugin configuration.
 */
export interface NJWorkZonesPluginConfig extends BasePluginConfig {
  /** Only include work zones that close one or more lanes. Default: false */
  closuresOnly?: boolean;
}

/**
 * Jersey City center (across the Hudson from Lower Manhattan).
 */
const JERSEY_CITY_CENTER = {
  latitude: 40.7178,
  longitude: -74.0431,
};

/**
 * Coverage radius (~30km covers Jersey City, Hoboken, Newark/EWR, Elizabeth,
 * and the Hudson crossings).
 */
const COVERAGE_RADIUS_METERS = 30_000;

/**
 * Derive a risk level from a WZDx work-zone description + vehicle_impact.
 *
 * The NJ feed reports `vehicle_impact` as "all-lanes-open" for every record, so
 * the closure detail lives in the free-text description — parse it. Exported for
 * testing.
 */
export function mapWorkZoneRisk(description?: string, vehicleImpact?: string): RiskLevel {
  const impact = (vehicleImpact ?? '').toLowerCase();
  if (impact === 'all-lanes-closed') return 'severe';
  if (impact === 'some-lanes-closed' || impact === 'alternating-one-way') return 'moderate';

  const d = (description ?? '').toLowerCase();
  if (
    d.includes('all lanes closed') ||
    d.includes('road closed') ||
    d.includes('fully closed') ||
    d.includes('full closure') ||
    d.includes('closed in both')
  ) {
    return 'severe';
  }
  if (d.includes('lane closed') || d.includes('lanes closed') || d.includes('ramp closed')) {
    return 'moderate';
  }
  if (d.includes('shoulder closed') || d.includes('closed')) {
    return 'low';
  }
  return 'low';
}

/**
 * Plugin that surfaces active road work zones (lane/ramp closures, construction)
 * for the Jersey City / northern NJ area from the NJDOT WZDx feed.
 *
 * Keyless. NOTE: this covers WORK ZONES only (roadwork, closures) — not
 * crashes/incidents. NJ has no public real-time incident API; full NJ incident
 * coverage (incl. Port Authority/PATH) comes from TRANSCOM (see TRANSCOMPlugin),
 * which is pending registration. The WZDx feed is itself TRANSCOM-sourced.
 *
 * @see https://smartworkzones.njit.edu/nj/wzdx
 * @see https://datahub.transportation.gov/d/69qe-yiui (WZDx feed registry)
 */
export class NJWorkZonesPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'nj-workzones',
    name: 'New Jersey Work Zones (WZDx)',
    version: '1.0.0',
    description: 'Active road work zones and lane closures for Jersey City / northern NJ',
    coverage: {
      type: 'regional',
      center: JERSEY_CITY_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'Jersey City, Hoboken, Newark (EWR), Elizabeth and Hudson crossings',
    },
    temporal: {
      supportsPast: false,
      supportsFuture: true,
      dataLagMinutes: 60,
      futureLookaheadMinutes: 10080,
      freshnessDescription: 'Active and scheduled work zones',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['traffic'],
    refreshIntervalMs: 30 * 60 * 1000,
    defaultRadiusMeters: 5_000,
  };

  private wzConfig: NJWorkZonesPluginConfig;

  constructor(config?: NJWorkZonesPluginConfig) {
    super(config);
    this.wzConfig = {
      closuresOnly: false,
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
        () => this.fetchWorkZones(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('NJ Work Zones fetch error:', error);
      throw error;
    }
  }

  private async fetchWorkZones(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const url = 'https://smartworkzones.njit.edu/nj/wzdx';

    try {
      // The NJ WZDx server double-encodes the body as a JSON string when
      // Accept: application/json is sent — unwrap it if so.
      let feed = await this.fetchJson<WZDxFeed | string>(url);
      if (typeof feed === 'string') {
        feed = JSON.parse(feed) as WZDxFeed;
      }
      if (!feed.features || !Array.isArray(feed.features)) {
        return [];
      }

      const startTime = new Date(timeRange.start).getTime();
      const endTime = new Date(timeRange.end).getTime();

      const alerts = [];
      for (const feature of feed.features) {
        const point = this.firstPoint(feature.geometry);
        if (!point) continue;

        const distance = this.calculateDistance(location.latitude, location.longitude, point.lat, point.lng);
        if (distance > radiusMeters) continue;

        const props = feature.properties ?? {};
        const wzStart = props.start_date ? new Date(props.start_date).getTime() : null;
        const wzEnd = props.end_date ? new Date(props.end_date).getTime() : null;

        // Time-window overlap (when dates are present)
        if (wzStart !== null) {
          const effectiveEnd = wzEnd ?? endTime;
          if (effectiveEnd < startTime || wzStart > endTime) continue;
        }

        const risk = mapWorkZoneRisk(props.core_details?.description, props.vehicle_impact);
        if (this.wzConfig.closuresOnly && risk === 'low') continue;

        alerts.push(this.transformFeature(feature, point, risk));
      }

      return alerts;
    } catch (error) {
      warnings.push(
        `Failed to fetch NJ work zones (WZDx): ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  private transformFeature(
    feature: WZDxFeature,
    point: { lat: number; lng: number },
    riskLevel: RiskLevel
  ) {
    const props = feature.properties ?? {};
    const cd = props.core_details ?? {};
    const roads = (cd.road_names ?? []).filter(Boolean);
    const start = props.start_date ? new Date(props.start_date) : null;
    const end = props.end_date ? new Date(props.end_date) : null;
    const id = feature.id ?? `${roads[0] ?? 'wz'}-${props.start_date ?? ''}`;

    const title = roads.length
      ? `Work Zone on ${roads[0]}${cd.direction ? ` (${cd.direction})` : ''}`
      : 'Road Work Zone';

    return this.createAlert({
      id: `nj-workzone-${id}`,
      externalId: id,
      title,
      description: cd.description || this.buildFallbackDescription(cd, props),
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'traffic',
      temporalType: start && start.getTime() > Date.now() ? 'scheduled' : 'real-time',
      location: {
        point: { latitude: point.lat, longitude: point.lng },
        address: roads.join(' / ') || cd.description,
        city: 'Jersey City',
        state: 'NJ',
      },
      timestamps: {
        issued: cd.update_date ?? props.start_date ?? new Date().toISOString(),
        eventStart: start ? start.toISOString() : undefined,
        eventEnd: end ? end.toISOString() : undefined,
      },
      metadata: {
        eventType: cd.event_type,
        dataSource: cd.data_source_id,
        roads,
        direction: cd.direction,
        vehicleImpact: props.vehicle_impact,
        typesOfWork: (props.types_of_work ?? []).map((t) => t.type_name).filter(Boolean),
        beginningCrossStreet: props.beginning_cross_street,
      },
    });
  }

  private buildFallbackDescription(
    cd: NonNullable<WZDxFeature['properties']['core_details']>,
    props: WZDxFeature['properties']
  ): string {
    const parts: string[] = [];
    const roads = (cd.road_names ?? []).filter(Boolean);
    if (roads.length) parts.push(`Roadway: ${roads.join(' / ')}${cd.direction ? ` (${cd.direction})` : ''}`);
    const tow = (props.types_of_work ?? []).map((t) => t.type_name).filter(Boolean);
    if (tow.length) parts.push(`Work: ${tow.join(', ')}`);
    if (props.vehicle_impact) parts.push(`Impact: ${props.vehicle_impact}`);
    return parts.join('\n') || 'Road work zone';
  }

  /**
   * First coordinate of a WZDx geometry as {lat,lng}.
   */
  private firstPoint(geometry: WZDxFeature['geometry']): { lat: number; lng: number } | null {
    if (!geometry || !geometry.coordinates) return null;
    const c = geometry.coordinates;
    let pair: number[] | undefined;
    if (geometry.type === 'Point') {
      pair = c as number[];
    } else {
      pair = (c as number[][])[0];
    }
    if (!pair || pair.length < 2 || typeof pair[0] !== 'number' || typeof pair[1] !== 'number') {
      return null;
    }
    return { lat: pair[1], lng: pair[0] };
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
