import type { PluginMetadata, PluginFetchOptions, PluginFetchResult, RiskLevel } from '../../types';
import { BasePlugin, BasePluginConfig } from '../base-plugin';
import { SUBWAY_STATIONS } from './subway-stations';

/**
 * GTFS-realtime alert (JSON form) with the MTA "Mercury" extension.
 */
interface GtfsRtTranslation {
  text?: string;
  language?: string;
}
interface MercuryAlert {
  created_at?: number;
  updated_at?: number;
  alert_type?: string;
}
interface GtfsRtAlert {
  active_period?: Array<{ start?: number; end?: number }>;
  informed_entity?: Array<{ agency_id?: string; route_id?: string; stop_id?: string }>;
  header_text?: { translation?: GtfsRtTranslation[] };
  description_text?: { translation?: GtfsRtTranslation[] };
  'transit_realtime.mercury_alert'?: MercuryAlert;
}
interface GtfsRtEntity {
  id?: string;
  alert?: GtfsRtAlert;
}
interface GtfsRtFeed {
  header?: { timestamp?: number };
  entity?: GtfsRtEntity[];
}

/**
 * MTA Alerts plugin configuration.
 */
export interface MTAAlertsPluginConfig extends BasePluginConfig {
  /** Include "Planned -" work/maintenance alerts. Default: true */
  includePlanned?: boolean;
}

/**
 * NYC center (Midtown/Manhattan).
 */
const NYC_CENTER = {
  latitude: 40.73,
  longitude: -73.99,
};

const COVERAGE_RADIUS_METERS = 30_000;

/**
 * Mercury alert_type -> risk level. Unplanned disruptions outrank planned work.
 */
const ALERT_TYPE_RISK: Record<string, RiskLevel> = {
  delays: 'high',
  'expect delays': 'high',
  'reduced service': 'high',
  'no scheduled service': 'severe',
  suspended: 'severe',
  'some delays': 'moderate',
  'service change': 'moderate',
  'boarding change': 'moderate',
  'special schedule': 'moderate',
  'special notice': 'low',
  'station notice': 'low',
  'extra service': 'low',
};

/**
 * Plugin that surfaces MTA subway service alerts (delays, suspensions, reroutes,
 * planned work) from the MTA's GTFS-realtime "all alerts" JSON feed.
 *
 * GTFS-RT alerts are not coordinate-tagged — they reference GTFS route_ids and
 * stop_ids. This plugin joins stop_ids to station coordinates (bundled from the
 * MTA Subway Stations dataset) so alerts fit the point+radius model. Line-wide
 * alerts with no resolvable stop are skipped (reported in warnings).
 *
 * No API key required.
 *
 * @see https://api.mta.info/ (GTFS-realtime service alerts)
 * @see https://data.ny.gov/d/39hk-dx4f (station coordinates)
 */
export class MTAAlertsPlugin extends BasePlugin {
  readonly metadata: PluginMetadata = {
    id: 'mta-alerts',
    name: 'MTA Subway Service Alerts',
    version: '1.0.0',
    description: 'Subway delays, suspensions, reroutes, and planned work from the MTA',
    coverage: {
      type: 'regional',
      center: NYC_CENTER,
      radiusMeters: COVERAGE_RADIUS_METERS,
      description: 'NYC subway system (five boroughs)',
    },
    temporal: {
      supportsPast: false,
      supportsFuture: true,
      dataLagMinutes: 5,
      futureLookaheadMinutes: 10080,
      freshnessDescription: 'Near real-time service alerts',
    },
    supportedTemporalTypes: ['real-time', 'scheduled'],
    supportedCategories: ['traffic'],
    refreshIntervalMs: 5 * 60 * 1000,
    defaultRadiusMeters: 2_000,
  };

  private mtaConfig: MTAAlertsPluginConfig;

  constructor(config?: MTAAlertsPluginConfig) {
    super(config);
    this.mtaConfig = {
      includePlanned: true,
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
        () => this.fetchAlertsImpl(location, radiusMeters, timeRange, warnings),
        this.config.cacheTtlMs
      );

      return {
        alerts: data,
        fromCache,
        cacheKey,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      console.error('MTA Alerts fetch error:', error);
      throw error;
    }
  }

  private async fetchAlertsImpl(
    location: { latitude: number; longitude: number },
    radiusMeters: number,
    timeRange: { start: string; end: string },
    warnings: string[]
  ) {
    const url = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts.json';

    try {
      const feed = await this.fetchJson<GtfsRtFeed>(url);
      const entities = feed.entity ?? [];

      const startTime = new Date(timeRange.start).getTime();
      const endTime = new Date(timeRange.end).getTime();

      const alerts = [];
      let skippedNoGeo = 0;

      for (const entity of entities) {
        const alert = entity.alert;
        if (!alert) continue;

        const alertType = alert['transit_realtime.mercury_alert']?.alert_type ?? '';

        // Planned-work filter
        if (!this.mtaConfig.includePlanned && /^planned/i.test(alertType)) {
          continue;
        }

        // Resolve informed stops to coordinates, keep those within radius.
        const stopIds = (alert.informed_entity ?? [])
          .map((ie) => ie.stop_id)
          .filter((s): s is string => !!s);

        const resolvable = stopIds.map((s) => SUBWAY_STATIONS[s]).filter(Boolean);
        if (resolvable.length === 0) {
          if (stopIds.length === 0) {
            // line-wide alert (route only) — not geolocatable in a point model
            skippedNoGeo++;
          }
          continue;
        }

        // Nearest informed stop to the query location.
        let nearest: { lat: number; lng: number; name: string; boro: string } | null = null;
        let nearestDist = Infinity;
        for (const st of resolvable) {
          const d = this.calculateDistance(location.latitude, location.longitude, st.lat, st.lng);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = st;
          }
        }
        if (!nearest || nearestDist > radiusMeters) continue;

        // Time-window filter against active_period (if present).
        const periods = alert.active_period ?? [];
        if (periods.length > 0) {
          const overlaps = periods.some((p) => {
            const s = p.start ? p.start * 1000 : startTime;
            const e = p.end ? p.end * 1000 : endTime;
            return e >= startTime && s <= endTime;
          });
          if (!overlaps) continue;
        }

        alerts.push(this.transformAlert(entity, alert, alertType, nearest, stopIds.length));
      }

      if (skippedNoGeo > 0) {
        warnings.push(`Skipped ${skippedNoGeo} line-wide MTA alert(s) with no station-level location.`);
      }

      return alerts;
    } catch (error) {
      warnings.push(
        `Failed to fetch MTA service alerts: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return [];
    }
  }

  private transformAlert(
    entity: GtfsRtEntity,
    alert: GtfsRtAlert,
    alertType: string,
    station: { lat: number; lng: number; name: string; boro: string },
    affectedStopCount: number
  ) {
    const riskLevel = this.mapAlertTypeToRisk(alertType);
    const header = this.firstTranslation(alert.header_text?.translation);
    const description = this.firstTranslation(alert.description_text?.translation);
    const merc = alert['transit_realtime.mercury_alert'];
    const issuedMs = (merc?.updated_at ?? merc?.created_at ?? alert.active_period?.[0]?.start) ?? null;
    const issued = issuedMs ? new Date(issuedMs * 1000).toISOString() : new Date().toISOString();
    const start = alert.active_period?.[0]?.start;
    const end = alert.active_period?.[0]?.end;

    const routes = Array.from(
      new Set((alert.informed_entity ?? []).map((ie) => ie.route_id).filter(Boolean))
    );

    return this.createAlert({
      id: `mta-${entity.id ?? `${station.name}-${alertType}`}`,
      externalId: entity.id,
      title: alertType ? `${alertType}: ${header || station.name}` : header || `Service alert near ${station.name}`,
      description: description || header || alertType || 'MTA service alert',
      riskLevel,
      priority: this.riskLevelToPriority(riskLevel),
      category: 'traffic',
      temporalType: start && start * 1000 > Date.now() ? 'scheduled' : 'real-time',
      location: {
        point: { latitude: station.lat, longitude: station.lng },
        address: station.name,
        city: this.boroToCity(station.boro),
        state: 'NY',
      },
      timestamps: {
        issued,
        eventStart: start ? new Date(start * 1000).toISOString() : issued,
        eventEnd: end ? new Date(end * 1000).toISOString() : undefined,
      },
      metadata: {
        alertType,
        routes,
        affectedStops: affectedStopCount,
        nearestStation: station.name,
        borough: station.boro,
      },
    });
  }

  private mapAlertTypeToRisk(alertType: string): RiskLevel {
    const key = alertType.toLowerCase().replace(/^planned\s*-\s*/, '').trim();
    if (ALERT_TYPE_RISK[key]) return ALERT_TYPE_RISK[key];
    // Planned work defaults low; anything else moderate.
    if (/^planned/i.test(alertType)) return 'low';
    return 'moderate';
  }

  private firstTranslation(translations?: GtfsRtTranslation[]): string {
    if (!translations || translations.length === 0) return '';
    const en = translations.find((t) => (t.language ?? 'en').startsWith('en'));
    return (en ?? translations[0]).text ?? '';
  }

  private boroToCity(boro: string): string {
    const map: Record<string, string> = {
      M: 'Manhattan',
      Bk: 'Brooklyn',
      Q: 'Queens',
      Bx: 'Bronx',
      SI: 'Staten Island',
    };
    return map[boro] ?? 'New York';
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
